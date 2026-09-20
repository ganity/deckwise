#!/usr/bin/env python3
"""Derive DeckWise platform icon resources from the canonical logo.

The tracked ``apps/desktop/build/icon_1024.png`` file is the brand source of
truth. This script preserves that file and emits:

  apps/desktop/build/icon.iconset/  - all macOS iconset sizes
  apps/desktop/build/icon.icns      - via `iconutil` (macOS only)
  apps/desktop/build/icon.ico       - multi-size Windows application icon
  apps/desktop/build/icon.png       - 512px Windows/Linux package icon
  apps/desktop/build/tray-icon.png  - high-contrast Windows/Linux tray icon
  apps/desktop/build/tray-icon-mac.png - transparent macOS template icon

Run: python3 scripts/make-icon.py
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "apps" / "desktop" / "build"
SOURCE = BUILD / "icon_1024.png"

BASE = 1024


def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"canonical logo is missing: {SOURCE}")

    with Image.open(SOURCE) as source:
        master = source.convert("RGBA")
    if master.size != (BASE, BASE):
        raise ValueError(
            f"canonical logo must be {BASE}x{BASE}, got {master.width}x{master.height}"
        )

    BUILD.mkdir(parents=True, exist_ok=True)
    windows_icon = BUILD / "icon.ico"
    master.save(
        windows_icon,
        format="ICO",
        sizes=[
            (16, 16),
            (32, 32),
            (48, 48),
            (64, 64),
            (128, 128),
            (256, 256),
        ],
    )
    package_icon = BUILD / "icon.png"
    master.resize((512, 512), Image.LANCZOS).save(package_icon)

    # Windows/Linux do not tint tray images. A white mark with a dark edge
    # remains legible on both dark and light desktop panels at 16px.
    tray_alpha = master.getchannel("A")
    mark_bounds = tray_alpha.getbbox()
    if mark_bounds is None:
        raise ValueError("canonical logo does not contain a DeckWise mark")
    mark_alpha = tray_alpha.crop(mark_bounds)
    mark_alpha.thumbnail((820, 820), Image.LANCZOS)
    centered_alpha = Image.new("L", master.size, 0)
    centered_alpha.paste(
        mark_alpha,
        ((BASE - mark_alpha.width) // 2, (BASE - mark_alpha.height) // 2),
    )
    tray_icon = Image.new("RGBA", master.size, (24, 28, 31, 0))
    tray_icon.putalpha(centered_alpha.filter(ImageFilter.MaxFilter(41)))
    tray_foreground = Image.new("RGBA", master.size, (255, 255, 255, 0))
    tray_foreground.putalpha(centered_alpha)
    tray_icon.alpha_composite(tray_foreground)
    tray_icon_path = BUILD / "tray-icon.png"
    tray_icon.resize((512, 512), Image.LANCZOS).save(tray_icon_path)

    # macOS menu bar icons are template images: only the source mark's alpha
    # matters because the system supplies the light/dark tint.
    tray_icon_mac = Image.new("RGBA", master.size, (0, 0, 0, 0))
    tray_icon_mac.putalpha(tray_alpha)
    mark = tray_icon_mac.crop(mark_bounds).resize((768, 768), Image.LANCZOS)
    tray_icon_mac = Image.new("RGBA", master.size, (0, 0, 0, 0))
    tray_icon_mac.paste(mark, (128, 128), mark)
    tray_icon_mac_path = BUILD / "tray-icon-mac.png"
    tray_icon_mac.save(tray_icon_mac_path)

    iconset = BUILD / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    sizes = [16, 32, 128, 256, 512]
    for sz in sizes:
        master.resize((sz, sz), Image.LANCZOS).save(iconset / f"icon_{sz}x{sz}.png")
        master.resize((sz * 2, sz * 2), Image.LANCZOS).save(
            iconset / f"icon_{sz}x{sz}@2x.png"
        )

    icns = BUILD / "icon.icns"
    iconutil = shutil.which("iconutil")
    if iconutil is None:
        master.save(icns, format="ICNS")
    else:
        subprocess.run(
            [iconutil, "-c", "icns", str(iconset), "-o", str(icns)], check=True
        )
    print(f"used {SOURCE}")
    print(f"wrote {windows_icon}")
    print(f"wrote {package_icon}")
    print(f"wrote {tray_icon_path}")
    print(f"wrote {tray_icon_mac_path}")
    print(f"wrote {icns}")


if __name__ == "__main__":
    main()
