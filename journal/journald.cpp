/*
 * journal/journald.cpp  —  追加写日志 / 崩溃恢复服务 (Write-Ahead Log)
 * ---------------------------------------------------------------------------
 * 语言分工：C++ 负责持久化与校验。选它的原因是：
 *   - 需要零拷贝式的大缓冲写入 + 精确的文件布局（RAII 管理 fd / FILE*）
 *   - 需要 CRC32 校验，保证日志被截断或损坏时仍能恢复到「最后一条完好记录」
 *   - 需要模板/STL 的容器与字符串处理，但仍在毫秒级以内
 *
 * 日志格式（data/journal.log，逐行）：
 *   #<8 位十六进制 CRC32>#<JSON>\n
 *   JSON 里的文本字段全部用 base64，因此不需要任何转义，C/C++/Python 都能
 *   安全解析：{"ts":..,"type":"COMMIT","rev":..,"delta":..,"total":..,
 *             "current":..,"now":..,"order_b64":"..","product_b64":".."}
 *
 * 协议（Unix Domain Socket，逐行）：
 *   APPEND <type> <rev> <delta> <total> <current> <now> <ob64> <pb64>
 *   LAST    -> LAST <rev> <total> <current> <now> <ob64> <pb64> | NONE
 *   STATS   -> STATS <records> <bytes> <last_ts> <path>
 *   SYNC    -> SYNC <records>
 */

#include <arpa/inet.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <string>
#include <vector>

namespace {

constexpr size_t kMaxClients = 8;
constexpr size_t kInCap = 16384;
constexpr off_t kRotateBytes = 8 * 1024 * 1024;

struct Crc32 {
    uint32_t table[256];
    Crc32() {
        for (uint32_t i = 0; i < 256; ++i) {
            uint32_t c = i;
            for (int k = 0; k < 8; ++k) c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
            table[i] = c;
        }
    }
    uint32_t operator()(const char* data, size_t len) const {
        uint32_t c = 0xFFFFFFFFu;
        for (size_t i = 0; i < len; ++i)
            c = table[(c ^ static_cast<unsigned char>(data[i])) & 0xFF] ^ (c >> 8);
        return c ^ 0xFFFFFFFFu;
    }
};

Crc32 g_crc;

long long now_ms() {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return static_cast<long long>(ts.tv_sec) * 1000LL + ts.tv_nsec / 1000000L;
}

void log_line(const char* level, const std::string& msg) {
    std::fprintf(stderr, "[journal %lld] %s %s\n", now_ms(), level, msg.c_str());
    std::fflush(stderr);
}

int send_all(int fd, const char* buf, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        ssize_t w = write(fd, buf + sent, len - sent);
        if (w < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        sent += static_cast<size_t>(w);
    }
    return 0;
}

/* ------------------------------------------------------------------ 状态 */

struct LastRecord {
    bool valid = false;
    unsigned long long rev = 0, total = 0, current = 0, now = 0;
    std::string order_b64, product_b64;
    std::string kv() const {
        if (!valid) return "";
        char buf[1024];
        std::snprintf(buf, sizeof(buf), "%llu %llu %llu %llu %s %s", rev, total,
                      current, now, order_b64.empty() ? "-" : order_b64.c_str(),
                      product_b64.empty() ? "-" : product_b64.c_str());
        return std::string(buf);
    }
};

struct Journal {
    std::string dir;
    std::string path;
    FILE* fp = nullptr;
    off_t bytes = 0;
    unsigned long long records = 0;
    long long last_ts = 0;
    LastRecord last;

    bool open() {
        path = dir + "/journal.log";
        fp = std::fopen(path.c_str(), "ab");
        if (!fp) {
            log_line("ERR", "无法打开日志文件 " + path + ": " + std::strerror(errno));
            return false;
        }
        struct stat st {};
        if (::stat(path.c_str(), &st) == 0) bytes = st.st_size;
        return true;
    }

    void close_fp() {
        if (fp) {
            std::fflush(fp);
            ::fsync(fileno(fp));
            std::fclose(fp);
            fp = nullptr;
        }
    }

    bool rotate_if_needed() {
        if (bytes < kRotateBytes) return true;
        close_fp();
        std::string old = dir + "/journal.log.1";
        ::unlink(old.c_str());
        if (::rename(path.c_str(), old.c_str()) != 0)
            log_line("WARN", std::string("轮转失败: ") + std::strerror(errno));
        else
            log_line("INFO", "日志已轮转 -> " + old);
        bytes = 0;
        return open();
    }

    /* 校验一行；成功返回 JSON 片段 */
    static bool verify(const std::string& line, std::string* json_out) {
        if (line.size() < 11 || line[0] != '#') return false;
        size_t p = line.find('#', 1);
        if (p != 9) return false;
        char hex[9];
        std::memcpy(hex, line.data() + 1, 8);
        hex[8] = '\0';
        uint32_t expect = static_cast<uint32_t>(std::strtoul(hex, nullptr, 16));
        std::string json = line.substr(p + 1);
        if (g_crc(json.data(), json.size()) != expect) return false;
        if (json_out) *json_out = json;
        return true;
    }

    /* 从 JSON 里取字段（值全部是 base64 / 数字，无转义） */
    static bool pick(const std::string& json, const char* key, std::string* out) {
        std::string pat = std::string("\"") + key + "\":";
        size_t p = json.find(pat);
        if (p == std::string::npos) return false;
        p += pat.size();
        if (p >= json.size()) return false;
        if (json[p] == '"') {
            size_t e = json.find('"', p + 1);
            if (e == std::string::npos) return false;
            *out = json.substr(p + 1, e - p - 1);
        } else {
            size_t e = p;
            while (e < json.size() && json[e] != ',' && json[e] != '}') ++e;
            *out = json.substr(p, e - p);
        }
        return true;
    }

    static unsigned long long to_u64(const std::string& s) {
        return std::strtoull(s.c_str(), nullptr, 10);
    }

    /* 启动时扫描最后一条完好记录 */
    void replay_last() {
        for (const std::string& f : {dir + "/journal.log.1", path}) {
            FILE* r = std::fopen(f.c_str(), "rb");
            if (!r) continue;
            std::string last_line;
            std::string cur;
            char buf[8192];
            while (size_t n = std::fread(buf, 1, sizeof(buf), r)) {
                cur.append(buf, n);
                size_t pos;
                while ((pos = cur.find('\n')) != std::string::npos) {
                    std::string line = cur.substr(0, pos);
                    cur.erase(0, pos + 1);
                    if (!line.empty()) last_line = line;
                }
            }
            std::fclose(r);
            std::string json;
            if (!last_line.empty() && verify(last_line, &json)) {
                LastRecord rec;
                std::string v;
                if (pick(json, "rev", &v)) rec.rev = to_u64(v);
                if (pick(json, "total", &v)) rec.total = to_u64(v);
                if (pick(json, "current", &v)) rec.current = to_u64(v);
                if (pick(json, "now", &v)) rec.now = to_u64(v);
                pick(json, "order_b64", &rec.order_b64);
                pick(json, "product_b64", &rec.product_b64);
                if (pick(json, "ts", &v)) last_ts = static_cast<long long>(to_u64(v));
                rec.valid = true;
                last = rec;
                log_line("INFO", "回放最后记录 rev=" + std::to_string(rec.rev));
            }
        }
        /* 统计总条数（用于 STATS，不影响恢复） */
        for (const std::string& f : {dir + "/journal.log.1", path}) {
            FILE* r = std::fopen(f.c_str(), "rb");
            if (!r) continue;
            char buf[16384];
            size_t n;
            while ((n = std::fread(buf, 1, sizeof(buf), r)) > 0) {
                for (size_t i = 0; i < n; ++i)
                    if (buf[i] == '\n') ++records;
            }
            std::fclose(r);
        }
    }

    bool append(const std::string& type, unsigned long long rev,
                unsigned long long delta, unsigned long long total,
                unsigned long long current, unsigned long long now,
                const std::string& ob64, const std::string& pb64) {
        if (!fp && !open()) return false;
        char json[4096];
        int n = std::snprintf(
            json, sizeof(json),
            "{\"ts\":%lld,\"type\":\"%s\",\"rev\":%llu,\"delta\":%llu,"
            "\"total\":%llu,\"current\":%llu,\"now\":%llu,"
            "\"order_b64\":\"%s\",\"product_b64\":\"%s\"}",
            now_ms(), type.c_str(), rev, delta, total, current, now,
            ob64.empty() ? "-" : ob64.c_str(), pb64.empty() ? "-" : pb64.c_str());
        if (n <= 0) return false;
        std::string payload(json, static_cast<size_t>(n));
        char head[16];
        std::snprintf(head, sizeof(head), "#%08x#", g_crc(payload.data(), payload.size()));
        std::string line = std::string(head) + payload + "\n";
        if (std::fwrite(line.data(), 1, line.size(), fp) != line.size()) {
            log_line("ERR", std::string("写日志失败: ") + std::strerror(errno));
            return false;
        }
        std::fflush(fp);
        bytes += static_cast<off_t>(line.size());
        ++records;
        last_ts = now_ms();
        last.valid = true;
        last.rev = rev;
        last.total = total;
        last.current = current;
        last.now = now;
        last.order_b64 = ob64;
        last.product_b64 = pb64;
        rotate_if_needed();
        return true;
    }

    void fsync_now() {
        if (fp) ::fsync(fileno(fp));
    }
};

/* ---------------------------------------------------------------- 服务端 */

struct Client {
    int fd = -1;
    std::string in;
};

Journal g_journal;
std::vector<Client> g_clients;

void reply(Client& c, const std::string& s) {
    if (c.fd < 0) return;
    if (send_all(c.fd, s.data(), s.size()) < 0) {
        ::close(c.fd);
        c.fd = -1;
    }
}

std::vector<std::string> split(const std::string& s, char sep = ' ') {
    std::vector<std::string> out;
    size_t i = 0;
    while (i <= s.size()) {
        size_t p = s.find(sep, i);
        if (p == std::string::npos) {
            out.push_back(s.substr(i));
            break;
        }
        out.push_back(s.substr(i, p - i));
        i = p + 1;
    }
    while (out.size() > 1 && out.back().empty()) out.pop_back();
    return out;
}

void handle(Client& c, const std::string& line) {
    auto tk = split(line);
    if (tk.empty() || tk[0].empty()) return;
    const std::string& cmd = tk[0];
    if (cmd == "APPEND") {
        if (tk.size() < 9) {
            reply(c, "ERR ARGS\n");
            return;
        }
        std::string type = tk[1];
        for (char& ch : type)
            if (!isalnum(static_cast<unsigned char>(ch))) ch = '_';
        g_journal.append(type, std::strtoull(tk[2].c_str(), nullptr, 10),
                         std::strtoull(tk[3].c_str(), nullptr, 10),
                         std::strtoull(tk[4].c_str(), nullptr, 10),
                         std::strtoull(tk[5].c_str(), nullptr, 10),
                         std::strtoull(tk[6].c_str(), nullptr, 10),
                         tk[7] == "-" ? "" : tk[7], tk[8] == "-" ? "" : tk[8]);
        char out[64];
        std::snprintf(out, sizeof(out), "OK %llu\n", g_journal.records);
        reply(c, out);
        return;
    }
    if (cmd == "LAST") {
        if (!g_journal.last.valid) {
            reply(c, "NONE\n");
        } else {
            reply(c, "LAST " + g_journal.last.kv() + "\n");
        }
        return;
    }
    if (cmd == "STATS") {
        char out[512];
        std::snprintf(out, sizeof(out), "STATS %llu %lld %lld %s\n",
                      g_journal.records, static_cast<long long>(g_journal.bytes),
                      g_journal.last_ts, g_journal.path.c_str());
        reply(c, out);
        return;
    }
    if (cmd == "SYNC") {
        g_journal.fsync_now();
        char out[64];
        std::snprintf(out, sizeof(out), "SYNC %llu\n", g_journal.records);
        reply(c, out);
        return;
    }
    reply(c, "ERR BAD_CMD\n");
}

int listen_unix(const std::string& path) {
    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        log_line("ERR", std::string("socket: ") + std::strerror(errno));
        std::exit(1);
    }
    sockaddr_un addr {};
    addr.sun_family = AF_UNIX;
    std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", path.c_str());
    ::unlink(path.c_str());
    if (::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        log_line("ERR", std::string("bind: ") + std::strerror(errno));
        std::exit(1);
    }
    ::chmod(path.c_str(), 0666);
    /* 非阻塞监听，避免 accept 阻塞主循环 */
    int flags = ::fcntl(fd, F_GETFL, 0);
    ::fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    if (::listen(fd, 32) < 0) {
        log_line("ERR", std::string("listen: ") + std::strerror(errno));
        std::exit(1);
    }
    return fd;
}

}  // namespace

int main(int argc, char** argv) {
    std::string sock_path = "/tmp/qwen-board/journal.sock";
    g_journal.dir = "data";
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--sock" && i + 1 < argc) sock_path = argv[++i];
        else if (a == "--dir" && i + 1 < argc) g_journal.dir = argv[++i];
    }

    ::mkdir(g_journal.dir.c_str(), 0755);
    if (!g_journal.open()) return 1;
    g_journal.replay_last();
    g_journal.append("BOOT", g_journal.last.rev, 0, g_journal.last.total,
                     g_journal.last.current, g_journal.last.now,
                     g_journal.last.order_b64, g_journal.last.product_b64);

    int lfd = listen_unix(sock_path);
    log_line("INFO", "监听 " + sock_path + "，日志 " + g_journal.path +
                         " (" + std::to_string(g_journal.records) + " 条)");

    long long last_sync = now_ms();
    for (;;) {
        std::vector<pollfd> pfds;
        pfds.push_back({lfd, POLLIN, 0});
        std::vector<size_t> idx;
        for (size_t i = 0; i < kMaxClients; ++i) {
            if (i < g_clients.size() && g_clients[i].fd >= 0) {
                pfds.push_back({g_clients[i].fd, POLLIN, 0});
                idx.push_back(i);
            }
        }
        int rc = ::poll(pfds.data(), pfds.size(), 200);
        if (rc < 0 && errno != EINTR) {
            log_line("ERR", std::string("poll: ") + std::strerror(errno));
            break;
        }
        if (rc > 0 && (pfds[0].revents & POLLIN)) {
            for (;;) {
                int fd = ::accept(lfd, nullptr, nullptr);
                if (fd < 0) break;
                bool placed = false;
                for (size_t i = 0; i < kMaxClients; ++i) {
                    if (i >= g_clients.size()) g_clients.resize(i + 1);
                    if (g_clients[i].fd < 0) {
                        g_clients[i].fd = fd;
                        g_clients[i].in.clear();
                        placed = true;
                        break;
                    }
                }
                if (!placed) ::close(fd);
            }
        }
        for (size_t k = 0; k < idx.size(); ++k) {
            Client& c = g_clients[idx[k]];
            if (c.fd < 0) continue;
            if (!(pfds[k + 1].revents & (POLLIN | POLLHUP | POLLERR))) continue;
            char buf[kInCap];
            ssize_t r = ::read(c.fd, buf, sizeof(buf));
            if (r <= 0) {
                ::close(c.fd);
                c.fd = -1;
                c.in.clear();
                continue;
            }
            c.in.append(buf, static_cast<size_t>(r));
            size_t pos;
            while ((pos = c.in.find('\n')) != std::string::npos) {
                std::string line = c.in.substr(0, pos);
                c.in.erase(0, pos + 1);
                if (c.fd >= 0) handle(c, line);
            }
            if (c.in.size() > kInCap * 2) c.in.clear();
        }
        long long t = now_ms();
        if (t - last_sync > 300) {
            g_journal.fsync_now();
            last_sync = t;
        }
    }
    g_journal.close_fp();
    return 0;
}
