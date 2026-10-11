import { useEffect, useState } from "react";

export type ImageFileError = "invalid_file" | "decode_failed" | "resolution_exceeded";
export function useImageFilePreview({ types, maxBytes, maxPixels, maxSide }: { types: readonly string[]; maxBytes: number; maxPixels: number; maxSide: number }) {
  const [file, setFile] = useState<File | null>(null);
  const [selection, setSelection] = useState(0);
  const [preview, setPreview] = useState("");
  const [status, setStatus] = useState<"checking" | "valid" | "invalid" | null>(null);
  const [error, setError] = useState<ImageFileError | null>(null);
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    let cancelled = false;
    setPreview(url);
    image.src = url;
    void image.decode().then(() => {
      if (cancelled) return;
      if (image.naturalWidth * image.naturalHeight > maxPixels || image.naturalWidth > maxSide || image.naturalHeight > maxSide) {
        setStatus("invalid"); setError("resolution_exceeded");
      } else setStatus("valid");
    }).catch(() => { if (!cancelled) { setStatus("invalid"); setError("decode_failed"); } });
    return () => { cancelled = true; image.src = ""; URL.revokeObjectURL(url); };
  }, [file, selection, maxPixels, maxSide]);
  function choose(selected?: File) {
    if (!selected) return false;
    if (!types.includes(selected.type) || selected.size === 0 || selected.size > maxBytes) {
      setFile(null); setPreview(""); setError("invalid_file"); setStatus("invalid");
      return false;
    }
    setFile(selected); setSelection((value) => value + 1); setStatus("checking"); setError(null); return true;
  }
  function clear() { setFile(null); setPreview(""); setStatus(null); setError(null); }
  function failPreview() { setStatus("invalid"); setError("decode_failed"); }
  return { file, preview, status, error, choose, clear, failPreview, canSave: Boolean(file) && status === "valid" && error === null };
}
