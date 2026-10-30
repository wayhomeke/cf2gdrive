#!/usr/bin/env python3
"""Offline publication check. Reports locations/categories, never matched values.

Checks tracked working-tree files, not Git history or ignored local secrets.
This is a heuristic guard, not a guarantee that every secret is detected.
"""
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RULES = {
    "private-key": r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    "google-secret": r"(?:GOCSPX-[\w-]{10,}|ya29\.[\w.-]{20,}|1//[\w-]{20,}|AIza[\w-]{30,})",
    "api-key": r"pb_live_[0-9a-fA-F]{48}\b",
    "literal-share-link": r"/(?:f/)?s/[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])",
    "personal-path": r"(?:/Users/|/home/)[A-Za-z0-9_.-]+/",
    "literal-session": r"(?:cookieVal|SESSION_COOKIE)\s*=\s*['\"][0-9a-fA-F]{32,}['\"]",
    "literal-credential": r"(?:client_secret|refresh_token|oauth_token|CLOUDFLARE_API_TOKEN|SESSION_SECRET)\s*[:=]\s*['\"][A-Za-z0-9_./+-]{24,}['\"]",
}
PRIVATE_NAMES = re.compile(
    r"(?:^|/)(?:\.dev\.vars(?:\..*)?|\.env(?:\..*)?|token\.json|tokens\.json|"
    r"client_secret[^/]*\.json|credentials[^/]*\.json|service-account[^/]*\.json|"
    r"wrangler\.local\.toml|[^/]+\.(?:pem|key|p12|pfx|sqlite3?|db))$"
)


def scan():
    names = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
    findings = []
    for name in filter(None, names):
        path = ROOT / name
        if not path.is_file():
            continue
        if PRIVATE_NAMES.search(name) and not name.endswith(".example"):
            findings.append((name, 1, "private-file-tracked"))
        text = path.read_text(encoding="utf-8", errors="replace")
        for line_no, line in enumerate(text.splitlines(), 1):
            for category, pattern in RULES.items():
                if re.search(pattern, line):
                    findings.append((name, line_no, category))
            if name.endswith(".toml"):
                match = re.search(r'database_id\s*=\s*"([^"]+)"', line)
                if match and match[1] != "00000000-0000-0000-0000-000000000000":
                    findings.append((name, line_no, "deployment-database-id"))
    return findings


if __name__ == "__main__":
    findings = scan()
    for name, line, category in findings:
        print(f"{name}:{line}: {category} [value withheld]")
    print(f"Public-source check: {len(findings)} finding(s). Git history is NOT checked.")
    raise SystemExit(bool(findings))
