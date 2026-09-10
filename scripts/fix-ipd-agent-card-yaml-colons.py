from pathlib import Path
import re

ROOT = Path("packages/ipd/assets")
CARD_DIRS = [
    ROOT / "agency-role-library" / "agent-cards",
    ROOT / "agent-cards",
]
TOP_LEVEL_STRING_LISTS = {
    "responsibilities",
    "nonResponsibilities",
    "applicableScenarios",
    "principles",
    "deliverables",
}
PROFILE_STRING_LISTS = {"approach", "communication", "verification"}


def rewrite(path: Path) -> int:
    lines = path.read_text(encoding="utf-8").splitlines()
    output: list[str] = []
    active_top: str | None = None
    active_profile: str | None = None
    converted = 0

    for line in lines:
        stripped = line.lstrip(" ")
        indent = len(line) - len(stripped)

        if indent == 0 and stripped.endswith(":") and not stripped.startswith("-"):
            key = stripped[:-1]
            active_top = key if key in TOP_LEVEL_STRING_LISTS else None
            active_profile = None
        elif indent == 2 and stripped.endswith(":") and not stripped.startswith("-"):
            key = stripped[:-1]
            active_profile = key if key in PROFILE_STRING_LISTS else None
        elif indent <= 2 and stripped and not stripped.startswith("-") and not stripped.startswith("#"):
            if indent < 2:
                active_profile = None

        in_string_list = (indent == 0 and active_top is not None) or (indent == 2 and active_profile is not None)
        if in_string_list:
            match = re.match(r"^(\s*)-\s+(.+)$", line)
            if match:
                prefix, value = match.groups()
                if value and value[0] not in "#'\"[{|>" and ": " in value:
                    output.append(f"{prefix}- |-")
                    output.append(f"{prefix}  {value}")
                    converted += 1
                    continue

        output.append(line)

    if converted:
        path.write_text("\n".join(output) + "\n", encoding="utf-8")
    return converted


def main() -> None:
    total = 0
    changed = 0
    for directory in CARD_DIRS:
        for path in sorted(directory.glob("*.yaml")):
            count = rewrite(path)
            if count:
                changed += 1
                total += count
                print(f"{path}: converted {count}")
    print(f"changed_files={changed} converted_scalars={total}")


if __name__ == "__main__":
    main()
