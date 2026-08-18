#!/usr/bin/env python3
"""Discover an HTTP MCP server and generate the ID4AI MCP manifest."""
import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

PROTOCOL_VERSION = "2025-06-18"


def normalize(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9_]+", "_", value)
    value = re.sub(r"_+", "_", value).strip("_")
    if not value:
        raise ValueError("identifier is empty after normalization")
    return value


def parse_sse(body: str):
    events = []
    data_lines = []
    for line in body.splitlines():
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
        elif not line.strip() and data_lines:
            events.append("\n".join(data_lines))
            data_lines = []
    if data_lines:
        events.append("\n".join(data_lines))
    for event in events:
        try:
            obj = json.loads(event)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            return obj
    raise RuntimeError("MCP endpoint returned SSE without a JSON-RPC data event")


class MCPHttpClient:
    def __init__(self, url: str):
        self.url = url
        self.session_id = None
        self.request_id = 0

    def post(self, payload, expect_response=True):
        raw = json.dumps(payload).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": PROTOCOL_VERSION,
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        request = urllib.request.Request(self.url, data=raw, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                sid = response.headers.get("Mcp-Session-Id")
                if sid:
                    self.session_id = sid
                body = response.read().decode("utf-8", errors="replace")
                if not expect_response:
                    return None
                ctype = response.headers.get("Content-Type", "")
                if "text/event-stream" in ctype:
                    return parse_sse(body)
                return json.loads(body) if body.strip() else None
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"MCP HTTP {exc.code}: {detail[:1000]}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"cannot reach MCP server: {exc}") from exc

    def request(self, method, params=None):
        self.request_id += 1
        payload = {"jsonrpc": "2.0", "id": self.request_id, "method": method}
        if params is not None:
            payload["params"] = params
        response = self.post(payload)
        if not isinstance(response, dict):
            raise RuntimeError(f"invalid JSON-RPC response for {method}")
        if response.get("error"):
            raise RuntimeError(f"MCP {method} failed: {json.dumps(response['error'])}")
        return response.get("result", {})

    def notify(self, method, params=None):
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        self.post(payload, expect_response=False)


def discover(server_name: str, url: str):
    normalized_server = normalize(server_name)
    client = MCPHttpClient(url)
    init = client.request("initialize", {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {"name": "id4ai-add-mcp", "version": "0.1.0"},
    })
    client.notify("notifications/initialized")
    capabilities = init.get("capabilities") or {}
    if "tools" not in capabilities:
        raise RuntimeError("MCP server did not advertise the tools capability")

    tools = []
    cursor = None
    seen_names = set()
    while True:
        params = {} if cursor is None else {"cursor": cursor}
        result = client.request("tools/list", params)
        page = result.get("tools") or []
        if not isinstance(page, list):
            raise RuntimeError("tools/list returned a non-list tools field")
        for tool in page:
            raw_name = tool.get("name")
            if not raw_name:
                raise RuntimeError("tools/list returned a tool without a name")
            if raw_name in seen_names:
                raise RuntimeError(f"duplicate tool name: {raw_name}")
            seen_names.add(raw_name)
            tools.append({
                "name": raw_name,
                "description": tool.get("description", ""),
                "inputSchema": tool.get("inputSchema", {}),
            })
        cursor = result.get("nextCursor")
        if not cursor:
            break

    return {
        "schemaVersion": 1,
        "mcpServerName": normalized_server,
        "mcpUrl": url,
        "protocolVersion": init.get("protocolVersion", PROTOCOL_VERSION),
        "serverInfo": init.get("serverInfo", {}),
        "tools": tools,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--server-name", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        manifest = discover(args.server_name, args.url)
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        print(f"Discovered {len(manifest['tools'])} tools")
        for tool in manifest["tools"]:
            print(f"  {tool['name']}")
        print(out)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
