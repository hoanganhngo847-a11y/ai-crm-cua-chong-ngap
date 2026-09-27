'use client';

import React, { useState, useRef } from 'react';
import type {
  SurveyPhotoSlot,
  SurveyPhotoPreview,
} from '../types/survey';
import {
  uploadSurveyPhotoAction,
  deleteSurveyPhotoAction,
  refreshPhotoSignedUrlAction,
} from '../../../app/(dashboard)/surveys/actions';

interface PhotoCaptureGridProps {
  appointmentId: string;
  photos: Record<string, SurveyPhotoPreview>;
  onChange: (photos: Record<string, SurveyPhotoPreview>) => void;
  disabled?: boolean;
}

interface SlotDefinition {
  slot: SurveyPhotoSlot;
  label: string;
  description: string;
  isMandatory: boolean;
}

export const PHOTO_SLOT_DEFINITIONS: SlotDefinition[] = [
  {
    slot: 'OVERVIEW',
    label: 'Ảnh toàn cảnh mặt tiền',
    description: 'Bao quát toàn bộ vị trí lắp đặt cửa, thấy rõ 2 bên má tường và nền nhà.',
    isMandatory: true,
  },
  {
    slot: 'BOTTOM_LEFT',
    label: 'Chân tường & sàn bên trái',
    description: 'Cận cảnh góc tiếp giáp giữa má tường trái và mặt sàn tiếp xúc.',
    isMandatory: true,
  },
  {
    slot: 'BOTTOM_RIGHT',
    label: 'Chân tường & sàn bên phải',
    description: 'Cận cảnh góc tiếp giáp giữa má tường phải và mặt sàn tiếp xúc.',
    isMandatory: true,
  },
  {
    slot: 'OBSTACLE',
    label: 'Chướng ngại vật / Gờ chỉ',
    description: 'Ống nước, gờ đá, hộp kỹ thuật, ổ cắm hoặc phào chỉ cản trở gắn ray (nếu có).',
    isMandatory: false,
  },
  {
    slot: 'SLOPE_DETAIL',
    label: 'Chi tiết dốc / Cốt nền',
    description: 'Độ dốc bậc tam cấp, rãnh thoát nước hoặc bề mặt gồ ghề.',
    isMandatory: false,
  },
  {
    slot: 'ADDITIONAL',
    label: 'Ảnh bổ sung hiện trường',
    description: 'Các góc quan sát khác hoặc chi tiết kỹ thuật cần lưu ý.',
    isMandatory: false,
  },
];

/**
 * Client-side image compression using HTML5 Canvas
 * Resizes max dimension to 1600px and exports as 80% JPEG
 */
async function compressImage(file: File, maxDimension = 1600, quality = 0.8): Promise<Blob> {
  return new Promise((resolve) => {
    // If not an image or SVG, return as is
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
      resolve(file);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;

        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(file);
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            resolve(blob || file);
          },
          'image/jpeg',
          quality
        );
      };
      img.onerror = () => resolve(file);
      img.src = e.target?.result as string;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

export default function PhotoCaptureGrid({
  appointmentId,
  photos,
  onChange,
  disabled = false,
}: PhotoCaptureGridProps) {
  const [uploadingSlot, setUploadingSlot] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<{ slot: string; message: string } | null>(null);
  const [previewModalUrl, setPreviewModalUrl] = useState<{ url: string; title: string } | null>(null);

  // Hidden inputs refs per slot
  const cameraInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const galleryInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const handleFileSelected = async (slotDef: SlotDefinition, file: File) => {
    setUploadingSlot(slotDef.slot);
    setUploadError(null);

    try {
      // 1. Client-side compression for faster 4G uploads
      const compressedBlob = await compressImage(file, 1600, 0.8);
      const uploadFile = new File([compressedBlob], `${slotDef.slot.toLowerCase()}.jpg`, {
        type: 'image/jpeg',
      });

      // 2. Prepare FormData
      const formData = new FormData();
      formData.append('appointmentId', appointmentId);
      formData.append('photoSlot', slotDef.slot);
      formData.append('file', uploadFile);

      // 3. Invoke Server Action
      const res = await uploadSurveyPhotoAction(formData);

      if (!res.success || !res.signedUrl) {
        throw new Error(res.message || 'Không thể tải ảnh lên hệ thống.');
      }

      // 4. Update photos dictionary
      const updatedItem: SurveyPhotoPreview = {
        slot: slotDef.slot,
        signedUrl: res.signedUrl,
        uploadedAt: new Date().toLocaleTimeString('vi-VN', {
          hour: '2-digit',
          minute: '2-digit',
        }),
        slotLabel: slotDef.label,
        isMandatory: slotDef.isMandatory,
      };

      const updatedPhotos = {
        ...photos,
        [slotDef.slot]: updatedItem,
      };

      onChange(updatedPhotos);
    } catch (err) {
      setUploadError({
        slot: slotDef.slot,
        message: err instanceof Error ? err.message : 'Lỗi tải ảnh lên.',
      });
    } finally {
      setUploadingSlot(null);
    }
  };

  const handleDeletePhoto = async (slot: SurveyPhotoSlot) => {
    const existingPhoto = photos[slot];
    if (!existingPhoto) return;

    if (!confirm(`Bạn có chắc muốn xóa ảnh "${existingPhoto.slotLabel}"?`)) {
      return;
    }

    try {
      setUploadingSlot(slot);
      const res = await deleteSurveyPhotoAction(appointmentId, slot);
      if (!res.success) {
        throw new Error(res.message || 'Không thể xóa ảnh.');
      }

      const nextPhotos = { ...photos };
      delete nextPhotos[slot];
      onChange(nextPhotos);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Không thể xóa ảnh.');
    } finally {
      setUploadingSlot(null);
    }
  };

  // Count progress
  const mandatoryCount = PHOTO_SLOT_DEFINITIONS.filter((s) => s.isMandatory).length;
  const mandatoryCompleted = PHOTO_SLOT_DEFINITIONS.filter(
    (s) => s.isMandatory && photos[s.slot]?.slot
  ).length;

  return (
    <div className="space-y-6">
      {/* Photo Header & Status Tracker */}
      <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider">
              Ảnh Hiện Trạng Vị Trí Lắp Đặt
            </h3>
            <span
              className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                mandatoryCompleted === mandatoryCount
                  ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-500/40'
                  : 'bg-amber-950/80 text-amber-400 border border-amber-500/40'
              }`}
            >
              Bắt buộc: {mandatoryCompleted}/{mandatoryCount}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Chụp trực tiếp bằng camera hoặc tải từ thư viện. Tự động nén để tiết kiệm 4G.
          </p>
        </div>

        {mandatoryCompleted < mandatoryCount ? (
          <div className="flex items-center gap-1.5 text-xs text-amber-400 font-medium">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>Cần thêm {mandatoryCount - mandatoryCompleted} ảnh bắt buộc</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span>Đã chụp đủ 3 ảnh bắt buộc</span>
          </div>
        )}
      </div>

      {/* Grid of Photo Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {PHOTO_SLOT_DEFINITIONS.map((def) => {
          const photo = photos[def.slot];
          const isUploading = uploadingSlot === def.slot;
          const slotErr = uploadError?.slot === def.slot ? uploadError.message : null;

          return (
            <div
              key={def.slot}
              className={`rounded-2xl border flex flex-col justify-between overflow-hidden transition ${
                photo
                  ? 'bg-slate-900 border-slate-700/80 shadow-lg'
                  : def.isMandatory
                  ? 'bg-slate-900/90 border-slate-800 hover:border-slate-700'
                  : 'bg-slate-900/50 border-slate-800/60'
              }`}
            >
              {/* Card Header */}
              <div className="p-3.5 pb-2 border-b border-slate-800/60">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-white leading-tight">{def.label}</span>
                  {def.isMandatory ? (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-950/80 text-rose-400 border border-rose-500/30 shrink-0">
                      Bắt buộc
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-800 text-slate-400 shrink-0">
                      Tùy chọn
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-400 mt-1 leading-snug line-clamp-2">
                  {def.description}
                </p>
              </div>

              {/* Card Body: Image Preview or Upload Placeholders */}
              <div className="p-3.5 flex-1 flex flex-col justify-center">
                {isUploading ? (
                  <div className="py-12 flex flex-col items-center justify-center space-y-2 text-center">
                    <div className="w-8 h-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                    <span className="text-xs text-blue-300 font-medium">Đang nén và tải ảnh...</span>
                  </div>
                ) : photo ? (
                  <div className="space-y-3">
                    {/* Thumbnail Image */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() =>
                        photo.signedUrl &&
                        setPreviewModalUrl({ url: photo.signedUrl, title: def.label })
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          if (photo.signedUrl) {
                            setPreviewModalUrl({ url: photo.signedUrl, title: def.label });
                          }
                        }
                      }}
                      className="relative aspect-video rounded-xl overflow-hidden bg-slate-950 group cursor-pointer border border-slate-800 hover:border-blue-500/60 transition"
                    >
                      {photo.signedUrl ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={photo.signedUrl}
                          alt={def.label}
                          className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                          onError={async () => {
                            const res = await refreshPhotoSignedUrlAction(appointmentId, def.slot);
                            if (res.success && res.signedUrl) {
                              onChange({
                                ...photos,
                                [def.slot]: {
                                  ...photo,
                                  signedUrl: res.signedUrl,
                                },
                              });
                            }
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={async () => {
                            const res = await refreshPhotoSignedUrlAction(appointmentId, def.slot);
                            if (res.success && res.signedUrl) {
                              onChange({
                                ...photos,
                                [def.slot]: {
                                  ...photo,
                                  signedUrl: res.signedUrl,
                                },
                              });
                            }
                          }}
                          className="w-full h-full flex flex-col items-center justify-center text-xs text-blue-400 hover:underline"
                        >
                          Tải lại xem trước
                        </button>
                      )}
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-1 text-white text-xs font-semibold">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
                        </svg>
                        <span>Xem ảnh lớn</span>
                      </div>
                      <div className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/70 backdrop-blur text-[10px] text-slate-300 font-mono">
                        {photo.uploadedAt}
                      </div>
                    </div>

                    {/* Actions: Retake / Delete */}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => cameraInputRefs.current[def.slot]?.click()}
                        className="flex-1 py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition flex items-center justify-center gap-1.5 disabled:opacity-50"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        <span>Chụp lại</span>
                      </button>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => handleDeletePhoto(def.slot)}
                        className="py-2 px-3 rounded-xl bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 border border-rose-500/30 text-xs font-medium transition flex items-center justify-center gap-1 disabled:opacity-50"
                        title="Xóa ảnh này"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        <span>Xóa</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="py-5 flex flex-col items-center justify-center space-y-3">
                    <div className="w-12 h-12 rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-center text-slate-500">
                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </div>

                    {/* Dual Action: Camera & File picker */}
                    <div className="w-full grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => cameraInputRefs.current[def.slot]?.click()}
                        className="py-2.5 px-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-md shadow-blue-600/20 active:scale-95 disabled:opacity-50"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        <span>Chụp ảnh</span>
                      </button>

                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => galleryInputRefs.current[def.slot]?.click()}
                        className="py-2.5 px-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition flex items-center justify-center gap-1.5 active:scale-95 disabled:opacity-50"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        <span>Thư viện</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Error Message for this Slot */}
                {slotErr && (
                  <div className="mt-2 p-2 rounded-lg bg-rose-950/60 border border-rose-500/40 text-[11px] text-rose-300 flex items-start gap-1">
                    <span className="text-rose-400 font-bold shrink-0">!</span>
                    <span>{slotErr}</span>
                  </div>
                )}
              </div>

              {/* Hidden Inputs for Direct Camera vs Gallery */}
              <input
                ref={(el) => {
                  cameraInputRefs.current[def.slot] = el;
                }}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                disabled={disabled || isUploading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    handleFileSelected(def, file);
                  }
                  e.target.value = '';
                }}
              />

              <input
                ref={(el) => {
                  galleryInputRefs.current[def.slot] = el;
                }}
                type="file"
                accept="image/*"
                className="hidden"
                disabled={disabled || isUploading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    handleFileSelected(def, file);
                  }
                  e.target.value = '';
                }}
              />
            </div>
          );
        })}
      </div>

      {/* Lightbox Preview Modal */}
      {previewModalUrl && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur flex items-center justify-center p-4 animate-in fade-in duration-200"
          onClick={() => setPreviewModalUrl(null)}
        >
          <div
            role="document"
            className="relative max-w-4xl w-full max-h-[90vh] flex flex-col items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-full flex items-center justify-between pb-3 text-white">
              <span className="text-sm font-bold">{previewModalUrl.title}</span>
              <button
                type="button"
                onClick={() => setPreviewModalUrl(null)}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewModalUrl.url}
              alt={previewModalUrl.title}
              className="max-h-[80vh] w-auto max-w-full object-contain rounded-xl border border-slate-800 shadow-2xl"
            />
          </div>
        </div>
      )}
    </div>
  );
}
