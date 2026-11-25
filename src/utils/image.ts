/**
 * Center-crops an uploaded photo into a crisp 256x256 JPEG data URL (~15-25 KB)
 * so real family portraits look sharp and store safely inside localStorage.
 */
export async function resizeImageToAvatarDataUrl(
  file: File,
  size = 256
): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose a valid image file (JPG, PNG, or WebP).");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not read the selected image."));
      el.src = objectUrl;
    });

    const minSide = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
    const sx = Math.max(0, Math.floor(((img.naturalWidth || img.width) - minSide) / 2));
    const sy = Math.max(0, Math.floor(((img.naturalHeight || img.height) - minSide) / 2));

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not prepare image canvas in this browser.");
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);

    return canvas.toDataURL("image/jpeg", 0.84);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
