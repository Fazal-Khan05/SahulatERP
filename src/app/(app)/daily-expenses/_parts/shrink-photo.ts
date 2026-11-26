// A phone's photo of a receipt is often larger than a file may be (4 MB). Before it is sent, a
// large photo is redrawn smaller in the browser: 2,000 points on its longer side is more than
// enough to read a bill. A PDF, a small photo, or a browser that cannot do this, is sent as it is.

const SHRINK_ABOVE_BYTES = 1.5 * 1024 * 1024;
const LONGER_SIDE = 2000;

export async function shrinkPhoto(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size <= SHRINK_ABOVE_BYTES) return file;
  try {
    const picture = await createImageBitmap(file);
    const scale = Math.min(1, LONGER_SIDE / Math.max(picture.width, picture.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(picture.width * scale));
    canvas.height = Math.max(1, Math.round(picture.height * scale));
    const pen = canvas.getContext("2d");
    if (!pen) return file;
    // A receipt is dark on light: a see-through PNG is put on white, not on black.
    pen.fillStyle = "#fff";
    pen.fillRect(0, 0, canvas.width, canvas.height);
    pen.drawImage(picture, 0, 0, canvas.width, canvas.height);
    picture.close();
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[A-Za-z0-9]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}
