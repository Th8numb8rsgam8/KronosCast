from pathlib import Path
from PIL import Image

out_dir = Path(__file__).parent

def save_icon_asset(
    src_path: str,
    dst_path: Path,
    size: int = 1024,
    strip_alpha: bool = False,
    fallback_rgb: tuple[int, int, int] = (11, 15, 25),
) -> None:
    with Image.open(src_path) as img:
        if strip_alpha:
            if img.mode in ("RGBA", "LA") or ("transparency" in img.info):
                rgba = img.convert("RGBA")
                bg = Image.new("RGB", rgba.size, fallback_rgb)
                bg.paste(rgba, mask=rgba.split()[-1])
                out_img = bg
            else:
                out_img = img.convert("RGB")
        else:
            out_img = img.convert("RGBA") if (img.mode in ("RGBA", "LA") or "transparency" in img.info) else img.convert("RGB")

        resized = out_img.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(dst_path, format="PNG", optimize=True)
        print(f"Saved {dst_path}: size={resized.size}, mode={resized.mode}, bytes={dst_path.stat().st_size}")

# 1. Expo / iOS app icon (1024x1024, opaque RGB)
save_icon_asset("raw-icon.webp", out_dir / "icon.png", size=1024, strip_alpha=True)

# 2. Expo / Android adaptive icon (1024x1024)
save_icon_asset("raw-icon.webp", out_dir / "adaptive-icon.png", size=1024, strip_alpha=False)

# 3. Expo splash screen icon (1024x1024)
save_icon_asset("raw-splash-screen.webp", out_dir / "splash-icon.png", size=1024, strip_alpha=False)

# 4. Google Play Console store listing icon (512x512, < 1MB)
save_icon_asset("raw-icon.webp", out_dir / "play-store-icon-512.png", size=512, strip_alpha=False)