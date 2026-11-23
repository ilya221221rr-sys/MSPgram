// ============================================================
//  MSP AI — фото (v20): подготовка картинки для ИИ.
//  Картинка сжимается (до 1280 px, JPEG) прямо в браузере и уходит в ИИ
//  как data-URL — на сервер MSPgram / Supabase она не загружается.
// ============================================================
const MAX_SRC = 25 * 1024 * 1024; // исходный файл до 25 МБ

export function isImageFile(f) {
  return !!f && (/^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test(f.name || ''));
}

function loadImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать картинку (формат не поддерживается браузером)')); };
    img.src = url;
  });
}

/** Файл → { dataUrl, w, h, kb } (JPEG, сторона не больше max) */
export async function imageToDataUrl(file, max = 1280, quality = 0.82) {
  if (!isImageFile(file)) throw new Error('Это не картинка');
  if (file.size > MAX_SRC) throw new Error('Фото слишком большое (максимум 25 МБ)');
  let src; let w; let h;
  try {
    src = await createImageBitmap(file);
    w = src.width; h = src.height;
  } catch {
    src = await loadImg(file);
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const k = Math.min(1, max / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k)); const ch = Math.max(1, Math.round(h * k));
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); // прозрачность PNG → белый фон
  ctx.drawImage(src, 0, 0, cw, ch);
  if (src.close) try { src.close(); } catch { /* */ }
  const dataUrl = cv.toDataURL('image/jpeg', quality);
  return { dataUrl, w: cw, h: ch, kb: Math.round(dataUrl.length * 0.75 / 1024) };
}

/** Картинка из чата (публичный URL) → File */
export async function urlToFile(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error('Не удалось скачать фото');
  const blob = await res.blob();
  return new File([blob], 'photo.jpg', { type: blob.type || 'image/jpeg' });
}
