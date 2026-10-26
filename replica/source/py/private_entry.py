"""Issue a short private entry, without ML imports, token rotation, or service restarts."""
import json
import re
import urllib.request
from urllib.parse import urlsplit


def make_private_entry(base_url, state, port):
    from access_control import gateway_headers
    parsed = urlsplit(base_url)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/") or not parsed.hostname:
        raise ValueError("unsafe private entry base URL")
    if parsed.scheme != "https":
        raise ValueError("HTTPS required for remote private entry")
    endpoint = f"http://127.0.0.1:{port}/api/session/issue"
    request = urllib.request.Request(endpoint, data=b"{}", method="POST",
        headers={**gateway_headers(endpoint, state, port), "Content-Type": "application/json"})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=10) as response:
        raw = response.read(2049)
    if len(raw) > 2048:
        raise ValueError("oversized entry response")
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError("invalid entry response")
    grant = result.get("grant", "")
    if not isinstance(grant, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", grant):
        raise ValueError("invalid entry response")
    return base_url.rstrip("/") + "/#qtts-entry=" + grant


def display_private_entry(base_url, state, port):
    from html import escape
    from IPython.display import HTML, display
    link = make_private_entry(base_url, state, port)
    display(HTML(f'<a href="{escape(link, quote=True)}" target="_blank" rel="noopener noreferrer" style="font-size:18px">▶ 打开 QTTS 控制台（自动进入，无需解锁）</a>'))
    return None  # Never return a capability as a Notebook expression output.
