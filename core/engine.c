/*
 * core/engine.c  —  「界面1」看板权威状态机 (Authoritative State Engine)
 * ---------------------------------------------------------------------------
 * 语言分工：C 负责「唯一真相 + 原子提交」这一层，因为它需要极低的延迟、
 * 确定性的内存布局和零 GC / 零运行时开销。Node(TypeScript) 只是它的
 * 传输层，绝不自己保存业务状态，因此多设备并发时不会出现状态分叉。
 *
 * 职责
 *   - 持有看板状态：生产单 / 产品 / 生产总数 / 当前生产数 / 现在 + 版本号 rev
 *   - 唯一的「确认」事务：current += n; total += n; now = 0; rev++
 *   - 输入校验（数字上限、UTF-8 截断、控制字符过滤）
 *   - 把每一次状态变更以 KV 协议推给 C++ 日志服务落盘（WAL）
 *   - 启动时从 C++ 日志服务回放最后一条有效记录，实现崩溃恢复
 *
 * 线路协议（Unix Domain Socket, 逐行 \n 分隔, 字段用 base64 传文本）
 *   GET                              -> STATE <rev> <total> <current> <now> <order_b64> <product_b64>
 *   SET <field> <b64|number>         -> STATE ...        field: order_no|product|current|now
 *   CONFIRM [<n>]                    -> COMMIT <rev> <delta> <total> <current> <now> <ob64> <pb64>
 *   RESET                            -> STATE ...
 *   PING                             -> PONG <rev>
 *
 * 编译: gcc -O2 -std=c11 -Wall -Wextra -o bin/engine core/engine.c
 */

#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define MAX_CLIENTS 64
#define IN_CAP 16384
#define TEXT_CAP 200
#define NUM_CAP 1000000000000ULL /* 1e12 上限，防止溢出与误输入 */

/* ------------------------------------------------------------------ util */

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (long long)ts.tv_sec * 1000LL + (long long)(ts.tv_nsec / 1000000L);
}

static void log_msg(const char *fmt, ...) {
    va_list ap;
    fprintf(stderr, "[engine %lld] ", now_ms());
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    fflush(stderr);
}

/* ---------------------------------------------------------------- base64 */

static const char B64_TAB[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static int b64_val(int c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

/* 返回写入 out 的字节数（不含结尾 0），out 至少 4*ceil(n/3)+1 字节 */
static size_t b64_encode(const unsigned char *in, size_t n, char *out) {
    size_t o = 0, i = 0;
    while (i + 3 <= n) {
        unsigned v = (unsigned)in[i] << 16 | (unsigned)in[i + 1] << 8 | in[i + 2];
        out[o++] = B64_TAB[(v >> 18) & 63];
        out[o++] = B64_TAB[(v >> 12) & 63];
        out[o++] = B64_TAB[(v >> 6) & 63];
        out[o++] = B64_TAB[v & 63];
        i += 3;
    }
    if (n - i == 1) {
        unsigned v = (unsigned)in[i] << 16;
        out[o++] = B64_TAB[(v >> 18) & 63];
        out[o++] = B64_TAB[(v >> 12) & 63];
        out[o++] = '=';
        out[o++] = '=';
    } else if (n - i == 2) {
        unsigned v = (unsigned)in[i] << 16 | (unsigned)in[i + 1] << 8;
        out[o++] = B64_TAB[(v >> 18) & 63];
        out[o++] = B64_TAB[(v >> 12) & 63];
        out[o++] = B64_TAB[(v >> 6) & 63];
        out[o++] = '=';
    }
    out[o] = '\0';
    return o;
}

/* 返回解码后的字节数，失败 -1 */
static int b64_decode(const char *in, unsigned char *out, size_t cap) {
    size_t o = 0, i = 0;
    int quad[4], qn = 0;
    while (in[i]) {
        int c = (unsigned char)in[i++];
        if (c == '=' || c == '\r' || c == '\n') continue;
        int v = b64_val(c);
        if (v < 0) return -1;
        quad[qn++] = v;
        if (qn == 4) {
            unsigned w = (unsigned)quad[0] << 18 | (unsigned)quad[1] << 12 |
                         (unsigned)quad[2] << 6 | (unsigned)quad[3];
            if (o + 3 > cap) return -1;
            out[o++] = (unsigned char)((w >> 16) & 0xFF);
            out[o++] = (unsigned char)((w >> 8) & 0xFF);
            out[o++] = (unsigned char)(w & 0xFF);
            qn = 0;
        }
    }
    if (qn == 2) {
        unsigned w = (unsigned)quad[0] << 18 | (unsigned)quad[1] << 12;
        if (o + 1 > cap) return -1;
        out[o++] = (unsigned char)((w >> 16) & 0xFF);
    } else if (qn == 3) {
        unsigned w = (unsigned)quad[0] << 18 | (unsigned)quad[1] << 12 |
                     (unsigned)quad[2] << 6;
        if (o + 2 > cap) return -1;
        out[o++] = (unsigned char)((w >> 16) & 0xFF);
        out[o++] = (unsigned char)((w >> 8) & 0xFF);
    } else if (qn == 1) {
        return -1;
    }
    return (int)o;
}

/* ---------------------------------------------------------------- state */

typedef struct {
    char order_no[TEXT_CAP + 1];
    char product[TEXT_CAP + 1];
    unsigned long long total;
    unsigned long long current;
    unsigned long long now;
    unsigned long long rev;
} Board;

static Board g_board;

/* 返回 s 中合法 UTF-8 前缀的长度 */
static size_t utf8_valid_prefix(const unsigned char *s, size_t n) {
    size_t i = 0;
    while (i < n) {
        unsigned char c = s[i];
        size_t need;
        if (c < 0x80) need = 1;
        else if ((c & 0xE0) == 0xC0) need = 2;
        else if ((c & 0xF0) == 0xE0) need = 3;
        else if ((c & 0xF8) == 0xF0) need = 4;
        else break;
        if (i + need > n) break;
        size_t k;
        for (k = 1; k < need; k++) {
            if ((s[i + k] & 0xC0) != 0x80) break;
        }
        if (k != need) break;
        i += need;
    }
    return i;
}

/* 过滤控制字符 + 截断到 TEXT_CAP（不切断多字节字符） */
static void put_text(char *dst, const unsigned char *src, size_t n) {
    unsigned char tmp[TEXT_CAP + 4];
    size_t o = 0;
    for (size_t i = 0; i < n && o < sizeof(tmp); i++) {
        if (src[i] < 0x20 || src[i] == 0x7F) continue;
        tmp[o++] = src[i];
    }
    size_t take = utf8_valid_prefix(tmp, o);
    if (take > TEXT_CAP) take = TEXT_CAP;
    /* 再退到合法边界 */
    while (take > 0 && utf8_valid_prefix(tmp, take) != take) take--;
    memcpy(dst, tmp, take);
    dst[take] = '\0';
}

static int parse_u64(const char *s, unsigned long long *out) {
    if (!s || !*s) {
        *out = 0;
        return 1;
    }
    unsigned long long v = 0;
    int digits = 0;
    for (const char *p = s; *p; p++) {
        if (*p < '0' || *p > '9') return 0;
        if (++digits > 15) return 0;
        v = v * 10 + (unsigned long long)(*p - '0');
    }
    if (v > NUM_CAP) v = NUM_CAP;
    *out = v;
    return 1;
}

/* -------------------------------------------------------------- journal */

static int g_jfd = -1;
static char g_journal_sock[108] = "";
static int g_journal_dirty = 1; /* 需要补写快照 */

static int connect_unix(const char *path, int timeout_ms) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", path);
    struct timeval tv;
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

static int send_all(int fd, const char *buf, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        ssize_t w = write(fd, buf + sent, len - sent);
        if (w < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        sent += (size_t)w;
    }
    return 0;
}

static void b64_fields(char *order_out, size_t oc, char *product_out,
                       size_t pc) {
    (void)oc;
    (void)pc;
    b64_encode((const unsigned char *)g_board.order_no,
               strlen(g_board.order_no), order_out);
    b64_encode((const unsigned char *)g_board.product, strlen(g_board.product),
               product_out);
}

/* APPEND <type> <rev> <delta> <total> <current> <now> <ob64> <pb64> */
static void journal_append(const char *type, unsigned long long delta) {
    if (g_jfd < 0) {
        g_journal_dirty = 1;
        return;
    }
    char ob64[4 * TEXT_CAP + 8], pb64[4 * TEXT_CAP + 8];
    b64_fields(ob64, sizeof(ob64), pb64, sizeof(pb64));
    char line[4 * TEXT_CAP * 2 + 256];
    int n = snprintf(line, sizeof(line),
                     "APPEND %s %llu %llu %llu %llu %llu %s %s\n", type,
                     g_board.rev, delta, g_board.total, g_board.current,
                     g_board.now, ob64[0] ? ob64 : "-", pb64[0] ? pb64 : "-");
    if (n <= 0) return;
    if (send_all(g_jfd, line, (size_t)n) < 0) {
        log_msg("journal 写入失败: %s", strerror(errno));
        close(g_jfd);
        g_jfd = -1;
        g_journal_dirty = 1;
    }
}

/* 从 journal 拉取最后一条记录并恢复状态；失败返回 0 */
static int journal_restore_from(int fd) {
    if (send_all(fd, "LAST\n", 5) < 0) return 0;
    char buf[4096];
    size_t len = 0;
    while (len < sizeof(buf) - 1) {
        ssize_t r = read(fd, buf + len, sizeof(buf) - 1 - len);
        if (r <= 0) {
            if (r < 0 && errno == EINTR) continue;
            return 0;
        }
        len += (size_t)r;
        if (memchr(buf, '\n', len)) break;
    }
    buf[len] = '\0';
    char *nl = strchr(buf, '\n');
    if (nl) *nl = '\0';
    if (strncmp(buf, "LAST ", 5) != 0) return 1; /* NONE -> 保持初值 */
    char *save = NULL;
    char *tok = strtok_r(buf + 5, " ", &save);
    unsigned long long f[4] = {0, 0, 0, 0};
    int fi = 0;
    char *ob64 = NULL, *pb64 = NULL;
    while (tok) {
        if (fi < 4) {
            if (!parse_u64(tok, &f[fi])) return 1;
        } else if (fi == 4) {
            ob64 = tok;
        } else if (fi == 5) {
            pb64 = tok;
        }
        fi++;
        tok = strtok_r(NULL, " ", &save);
    }
    if (fi < 6) return 1;
    g_board.rev = f[0];
    g_board.total = f[1];
    g_board.current = f[2];
    g_board.now = f[3];
    unsigned char tmp[TEXT_CAP + 1];
    int n;
    if (strcmp(ob64, "-") != 0) {
        n = b64_decode(ob64, tmp, TEXT_CAP);
        if (n >= 0) put_text(g_board.order_no, tmp, (size_t)n);
    }
    if (strcmp(pb64, "-") != 0) {
        n = b64_decode(pb64, tmp, TEXT_CAP);
        if (n >= 0) put_text(g_board.product, tmp, (size_t)n);
    }
    return 1;
}

static void journal_connect(void) {
    if (g_jfd >= 0) return;
    int fd = connect_unix(g_journal_sock, 3000);
    if (fd < 0) return;
    g_jfd = fd;
    log_msg("已连接日志服务 %s", g_journal_sock);
    if (g_journal_dirty) {
        journal_append("SNAPSHOT", 0);
        g_journal_dirty = 0;
    }
}

/* -------------------------------------------------------------- clients */

typedef struct {
    int fd;
    char in[IN_CAP];
    size_t in_len;
    int active;
} Client;

static Client g_clients[MAX_CLIENTS];

static void client_reply(Client *c, const char *buf, size_t len) {
    if (c->fd < 0) return;
    if (send_all(c->fd, buf, len) < 0) {
        log_msg("客户端写失败: %s", strerror(errno));
        close(c->fd);
        c->fd = -1;
        c->active = 0;
    }
}

static void reply_state(Client *c) {
    char ob64[4 * TEXT_CAP + 8], pb64[4 * TEXT_CAP + 8];
    b64_fields(ob64, sizeof(ob64), pb64, sizeof(pb64));
    char out[4 * TEXT_CAP * 2 + 256];
    int n = snprintf(out, sizeof(out), "STATE %llu %llu %llu %llu %s %s\n",
                     g_board.rev, g_board.total, g_board.current, g_board.now,
                     ob64[0] ? ob64 : "-", pb64[0] ? pb64 : "-");
    if (n > 0) client_reply(c, out, (size_t)n);
}

static void reply_commit(Client *c, unsigned long long delta) {
    char ob64[4 * TEXT_CAP + 8], pb64[4 * TEXT_CAP + 8];
    b64_fields(ob64, sizeof(ob64), pb64, sizeof(pb64));
    char out[4 * TEXT_CAP * 2 + 256];
    int n = snprintf(out, sizeof(out),
                     "COMMIT %llu %llu %llu %llu %llu %s %s\n", g_board.rev,
                     delta, g_board.total, g_board.current, g_board.now,
                     ob64[0] ? ob64 : "-", pb64[0] ? pb64 : "-");
    if (n > 0) client_reply(c, out, (size_t)n);
}

static void reply_err(Client *c, const char *code) {
    char out[128];
    int n = snprintf(out, sizeof(out), "ERR %s\n", code);
    if (n > 0) client_reply(c, out, (size_t)n);
}

/* 设置文本字段，返回是否有变化 */
static int set_text(char *dst, const char *b64) {
    /* 解码缓冲按 4 倍留余量：网关可能送来多字节文本，先收下再由 put_text 按
       UTF-8 边界截断到 TEXT_CAP 字节，避免"超长直接整条丢弃" */
    unsigned char tmp[4 * TEXT_CAP + 8];
    int n = 0;
    if (b64 && strcmp(b64, "-") != 0) {
        n = b64_decode(b64, tmp, sizeof(tmp));
        if (n < 0) return 0;
    }
    char next[TEXT_CAP + 1];
    put_text(next, tmp, (size_t)(n > 0 ? n : 0));
    if (strcmp(next, dst) == 0) return 0;
    memcpy(dst, next, strlen(next) + 1);
    return 1;
}

static void handle_line(Client *c, char *line) {
    char *save = NULL;
    char *cmd = strtok_r(line, " ", &save);
    if (!cmd) return;

    if (strcmp(cmd, "PING") == 0) {
        char out[64];
        int n = snprintf(out, sizeof(out), "PONG %llu\n", g_board.rev);
        if (n > 0) client_reply(c, out, (size_t)n);
        return;
    }
    if (strcmp(cmd, "GET") == 0) {
        reply_state(c);
        return;
    }
    if (strcmp(cmd, "SET") == 0) {
        char *field = strtok_r(NULL, " ", &save);
        char *val = strtok_r(NULL, "", &save);
        if (!field) {
            reply_err(c, "NO_FIELD");
            return;
        }
        int changed = 0;
        if (strcmp(field, "order_no") == 0) {
            changed = set_text(g_board.order_no, val);
        } else if (strcmp(field, "product") == 0) {
            changed = set_text(g_board.product, val);
        } else if (strcmp(field, "current") == 0 || strcmp(field, "now") == 0) {
            unsigned long long v = 0;
            if (!parse_u64(val, &v)) {
                reply_err(c, "BAD_NUMBER");
                return;
            }
            if (strcmp(field, "current") == 0) {
                if (g_board.current != v) {
                    g_board.current = v;
                    changed = 1;
                }
            } else {
                if (g_board.now != v) {
                    g_board.now = v;
                    changed = 1;
                }
            }
        } else {
            reply_err(c, "BAD_FIELD");
            return;
        }
        if (changed) {
            g_board.rev++;
            journal_append("SET", 0);
        }
        reply_state(c);
        return;
    }
    if (strcmp(cmd, "CONFIRM") == 0) {
        char *arg = strtok_r(NULL, " ", &save);
        unsigned long long delta;
        if (arg) {
            if (!parse_u64(arg, &delta)) {
                reply_err(c, "BAD_NUMBER");
                return;
            }
        } else {
            delta = g_board.now;
        }
        /* 唯一事务：当前生产数、生产总数累加，现在清零 */
        unsigned long long next_current = g_board.current + delta;
        unsigned long long next_total = g_board.total + delta;
        if (next_current > NUM_CAP) next_current = NUM_CAP;
        if (next_total > NUM_CAP) next_total = NUM_CAP;
        unsigned long long applied = next_current - g_board.current;
        g_board.current = next_current;
        g_board.total = next_total;
        g_board.now = 0;
        g_board.rev++;
        journal_append("COMMIT", applied);
        reply_commit(c, applied);
        return;
    }
    if (strcmp(cmd, "RESET") == 0) {
        /* 版本号必须单调递增，否则前端会把它当成过期状态丢弃 */
        unsigned long long next_rev = g_board.rev + 1;
        memset(&g_board, 0, sizeof(g_board));
        g_board.rev = next_rev;
        journal_append("RESET", 0);
        reply_state(c);
        return;
    }
    if (strcmp(cmd, "SHUTDOWN") == 0) {
        journal_append("SHUTDOWN", 0);
        reply_state(c);
        log_msg("收到 SHUTDOWN，退出");
        exit(0);
    }
    reply_err(c, "BAD_CMD");
}

/* --------------------------------------------------------------- server */

static int listen_unix(const char *path) {
    struct sockaddr_un addr;
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        log_msg("socket(): %s", strerror(errno));
        exit(1);
    }
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", path);
    unlink(path);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        log_msg("bind(%s): %s", path, strerror(errno));
        exit(1);
    }
    chmod(path, 0666);
    /* 关键：监听 socket 必须非阻塞，否则 accept 取完待处理连接后会阻塞事件循环 */
    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    if (listen(fd, 64) < 0) {
        log_msg("listen(): %s", strerror(errno));
        exit(1);
    }
    return fd;
}

int main(int argc, char **argv) {
    char sock_path[108] = "/tmp/qwen-board/core.sock";
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--sock") == 0 && i + 1 < argc) {
            snprintf(sock_path, sizeof(sock_path), "%s", argv[++i]);
        } else if (strcmp(argv[i], "--journal-sock") == 0 && i + 1 < argc) {
            snprintf(g_journal_sock, sizeof(g_journal_sock), "%s", argv[++i]);
        }
    }
    signal(SIGPIPE, SIG_IGN);
    setvbuf(stderr, NULL, _IONBF, 0);

    memset(&g_board, 0, sizeof(g_board));
    for (int i = 0; i < MAX_CLIENTS; i++) g_clients[i].fd = -1;

    /* 1) 崩溃恢复：先连日志服务，取最后一条记录 */
    if (g_journal_sock[0]) {
        for (int attempt = 0; attempt < 20; attempt++) {
            int fd = connect_unix(g_journal_sock, 1000);
            if (fd >= 0) {
                if (journal_restore_from(fd)) {
                    close(fd);
                    log_msg("状态已恢复 rev=%llu total=%llu current=%llu",
                            g_board.rev, g_board.total, g_board.current);
                } else {
                    close(fd);
                }
                break;
            }
            struct timespec ts = {0, 100 * 1000 * 1000};
            nanosleep(&ts, NULL);
        }
        journal_connect();
    }

    int lfd = listen_unix(sock_path);
    log_msg("监听 %s (rev=%llu)", sock_path, g_board.rev);

    struct pollfd pfds[MAX_CLIENTS + 2];
    for (;;) {
        int nfds = 0;
        pfds[nfds].fd = lfd;
        pfds[nfds].events = POLLIN;
        nfds++;
        int jslot = -1;
        if (g_jfd >= 0) {
            jslot = nfds;
            pfds[nfds].fd = g_jfd;
            pfds[nfds].events = POLLIN;
            nfds++;
        }
        int slots[MAX_CLIENTS];
        int nslots = 0;
        for (int i = 0; i < MAX_CLIENTS; i++) {
            if (g_clients[i].active) {
                slots[nslots] = i;
                pfds[nfds].fd = g_clients[i].fd;
                pfds[nfds].events = POLLIN;
                nfds++;
                nslots++;
            }
        }

        int rc = poll(pfds, (nfds_t)nfds, 500);
        if (rc < 0) {
            if (errno == EINTR) continue;
            log_msg("poll: %s", strerror(errno));
            break;
        }

        /* 新连接 */
        if (pfds[0].revents & POLLIN) {
            for (;;) {
                int fd = accept(lfd, NULL, NULL);
                if (fd < 0) break;
                int slot = -1;
                for (int i = 0; i < MAX_CLIENTS; i++) {
                    if (!g_clients[i].active) {
                        slot = i;
                        break;
                    }
                }
                if (slot < 0) {
                    close(fd);
                    continue;
                }
                g_clients[slot].fd = fd;
                g_clients[slot].in_len = 0;
                g_clients[slot].active = 1;
                reply_state(&g_clients[slot]);
            }
        }

        /* journal 应答（丢弃内容，仅用于探测存活） */
        if (jslot >= 0 && (pfds[jslot].revents & (POLLIN | POLLHUP | POLLERR))) {
            char tmp[512];
            ssize_t r = recv(g_jfd, tmp, sizeof(tmp), MSG_DONTWAIT);
            if (r == 0 || (r < 0 && errno != EAGAIN && errno != EWOULDBLOCK)) {
                log_msg("日志服务断开，稍后重连");
                close(g_jfd);
                g_jfd = -1;
                g_journal_dirty = 1;
            }
        }

        /* 客户端请求 */
        for (int s = 0; s < nslots; s++) {
            int idx = slots[s];
            struct pollfd *p = &pfds[2 + s];
            if (!(p->revents & (POLLIN | POLLHUP | POLLERR))) continue;
            Client *c = &g_clients[idx];
            ssize_t r = read(c->fd, c->in + c->in_len, IN_CAP - 1 - c->in_len);
            if (r <= 0) {
                close(c->fd);
                c->fd = -1;
                c->active = 0;
                c->in_len = 0;
                continue;
            }
            c->in_len += (size_t)r;
            c->in[c->in_len] = '\0';
            char *start = c->in;
            char *nl;
            while (c->active && (nl = memchr(start, '\n', c->in_len - (size_t)(start - c->in))) != NULL) {
                *nl = '\0';
                handle_line(c, start);
                start = nl + 1;
            }
            size_t used = (size_t)(start - c->in);
            if (c->active) {
                if (used > 0) {
                    memmove(c->in, start, c->in_len - used);
                    c->in_len -= used;
                }
                if (c->in_len >= IN_CAP - 1) c->in_len = 0; /* 超长行丢弃 */
                c->in[c->in_len] = '\0';
            }
        }

        /* journal 断线重连 */
        if (g_jfd < 0 && g_journal_sock[0]) {
            static long long last_try = 0;
            long long t = now_ms();
            if (t - last_try > 500) {
                last_try = t;
                journal_connect();
            }
        }
    }
    close(lfd);
    unlink(sock_path);
    return 0;
}
