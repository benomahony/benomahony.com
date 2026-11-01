# /// script
# requires-python = ">=3.13"
# ///
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

DRAFT = re.compile(r"^\.draft = true,$", re.MULTILINE)


def committed(path: Path) -> str:
    result = subprocess.run(["git", "show", f"HEAD:{path}"], capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else ""


def main(paths: list[str]) -> int:
    today = f'.date = .date("{date.today().isoformat()}T00:00:00"),'
    stale = [
        path
        for path in map(Path, paths)
        if not DRAFT.search(path.read_text())
        and DRAFT.search(committed(path))
        and today not in path.read_text()
    ]
    for path in stale:
        print(f"{path}: published but not dated today, set {today}")
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
