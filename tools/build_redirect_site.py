#!/usr/bin/env python3
"""Build the data-free migration site for the former GitHub Pages address."""
from __future__ import annotations

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NEW_BASE = "https://cn171g11.github.io/tencent-panorama-workbench/"
TEMPLATE = Path(__file__).resolve().parent / "templates" / "legacy-redirect.html"


def build_redirect_site(output: Path | str) -> list[str]:
    output = Path(output)
    if output.is_symlink():
        raise ValueError("Refusing a symlink output")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError("Refusing a nonempty output; choose a new directory")
    html = TEMPLATE.read_text(encoding="utf-8")
    output.mkdir(parents=True, exist_ok=True)
    names = ["index.html", "404.html", "city-viewer/index.html", "city-viewer/report.html"]
    # 为实际存在过的区域/线路入口提供200迁移页；其余深链接由404页接续。
    names += [f"{name}/index.html" for name in (
        "g101", "g102", "g103", "g106", "g212", "g312", "s341", "lishui-panorama",
        "erguna", "gaochun", "huma", "jgdaq", "mohe", "tahe", "xinlin",
    )]
    for name in names:
        path = output / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("x", encoding="utf-8", newline="\n") as file:
            file.write(html)
    with (output / ".nojekyll").open("xb"):
        pass
    return names + [".nojekyll"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / "legacy-redirect")
    args = parser.parse_args(argv)
    try:
        names = build_redirect_site(args.output)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Migration build failed: {error}\n")
    print(f"Migration site files={len(names)} target={NEW_BASE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
