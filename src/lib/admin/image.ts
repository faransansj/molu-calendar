import { MAX_UPLOAD_BYTES } from "./images.ts";

export interface PreparedUpload {
  blob: Blob;
  preview: string;
}

export async function prepareUpload(file: File): Promise<PreparedUpload> {
  if (file.size > 20 * 1024 * 1024) {
    throw new Error("이미지가 너무 커요.");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("이미지를 읽을 수 없어요.");
  }

  try {
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("이미지를 읽을 수 없어요.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    let blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/webp", 0.9);
    });
    if (!blob || blob.type !== "image/webp") {
      blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", 0.9);
      });
      if (!blob || blob.type !== "image/jpeg") {
        throw new Error("이미지를 읽을 수 없어요.");
      }
    }
    if (blob.size > MAX_UPLOAD_BYTES) {
      throw new Error("이미지는 5MB 이하여야 해요.");
    }

    const preview = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") resolve(reader.result);
        else reject(new Error("이미지를 읽을 수 없어요."));
      };
      reader.onerror = () => reject(new Error("이미지를 읽을 수 없어요."));
      reader.onabort = () => reject(new Error("이미지를 읽을 수 없어요."));
      reader.readAsDataURL(blob);
    });
    return { blob, preview };
  } finally {
    bitmap.close();
  }
}
