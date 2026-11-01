# /// script
# requires-python = ">=3.13"
# ///
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

DRAFT = re.compile(r"^\.draft = true,$", re.MULTILINE)
DATE = re.compile(r'^\.date = \.date\("[^"]*"\),$', re.MULTILINE)


def committed(path: Path) -> str:
    result = subprocess.run(["git", "show", f"HEAD:{path}"], capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else ""


def main(paths: list[str]) -> int:
    today = f'.date = .date("{date.today().isoformat()}T00:00:00"),'
    changed = 0
    for path in map(Path, paths):
        text = path.read_text()
        if DRAFT.search(text) or not DRAFT.search(committed(path)) or today in text:
            continue
        path.write_text(DATE.sub(today, text, count=1))
        print(f"{path}: published, date set to {date.today().isoformat()}")
        changed += 1
    return 1 if changed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
