'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import MeasurementForm from '../../../../features/survey/components/MeasurementForm';
import SiteConditionSelector from '../../../../features/survey/components/SiteConditionSelector';
import PhotoCaptureGrid from '../../../../features/survey/components/PhotoCaptureGrid';
import { validateSurveyInput } from '../../../../features/survey/validations/survey.schema';
import { completeSurveyAction, refreshPhotoSignedUrlAction } from '../actions';
import type {
  MeasurementData,
  SiteConditionData,
  SurveyDraft,
  SurveyPhotoDraftItem,
  SurveyPhotoPreview,
} from '../../../../features/survey/types/survey';

/**
 * Serializes Survey Draft for safe local browser storage.
 * Strictly guarantees that no sensitive fields (e.g. storage paths, buckets, signed URLs)
 * are ever persisted to localStorage. Only non-sensitive UI selectors and timestamps are preserved.
 */
export function serializeSurveyDraft(
  appointmentId: string,
  measurements: Partial<MeasurementData>,
  siteCondition: Partial<SiteConditionData>,
  photos: Record<string, SurveyPhotoPreview>,
  updatedAt: string
): SurveyDraft {
  const safePhotos: Record<string, SurveyPhotoDraftItem> = {};
  for (const [slot, photo] of Object.entries(photos || {})) {
    if (photo && photo.slot) {
      safePhotos[slot] = {
        slot: photo.slot,
        uploadedAt: photo.uploadedAt,
        slotLabel: photo.slotLabel,
        isMandatory: photo.isMandatory,
      };
    }
  }
  return {
    appointmentId,
    measurements,
    siteCondition,
    photos: safePhotos,
    updatedAt,
  };
}

interface Props {
  appointment: {
    id: string;
    company_id: string;
    customer_id: string;
    assignee_id: string;
    address: string;
    start_time: string;
    status: string;
  };
  customer: {
    id: string;
    customer_code: string;
    name: string;
  };
}

export default function SurveyMeasurementDetailClient({
  appointment,
  customer,
}: Props) {
  const router = useRouter();
  const storageKey = `survey_draft_v2_${appointment.id}`;

  // Form states
  const [measurements, setMeasurements] = useState<Partial<MeasurementData>>({
    clear_width_mm: undefined,
    barrier_height_mm: undefined,
    anticipated_flood_height_mm: undefined,
    width_top_mm: undefined,
    width_bottom_mm: undefined,
    gate_type: undefined,
    mounting_method: undefined,
  });

  const [siteCondition, setSiteCondition] = useState<Partial<SiteConditionData>>({
    wall_material: undefined,
    floor_material: undefined,
    floor_evenness: undefined,
    slope_grade: undefined,
    notes: '',
  });

  const [photos, setPhotos] = useState<Record<string, SurveyPhotoPreview>>({});

  const [activeTab, setActiveTab] = useState<'MEASURE' | 'SITE' | 'PHOTOS' | 'SUMMARY'>('MEASURE');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [hasRestoredDraft, setHasRestoredDraft] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionErrors, setSubmissionErrors] = useState<string[]>([]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // 1. Restore draft from localStorage asynchronously on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          const parsed: SurveyDraft = JSON.parse(saved);
          if (parsed.measurements) {
            setMeasurements(parsed.measurements);
          }
          if (parsed.siteCondition) {
            setSiteCondition(parsed.siteCondition);
          }
          if (parsed.photos) {
            const restoredPhotos: Record<string, SurveyPhotoPreview> = {};
            const slotsToRefresh: string[] = [];

            for (const [slot, item] of Object.entries(parsed.photos)) {
              if (item && item.slot) {
                restoredPhotos[slot] = {
                  slot: item.slot,
                  uploadedAt: item.uploadedAt,
                  slotLabel: item.slotLabel,
                  isMandatory: item.isMandatory,
                  signedUrl: undefined,
                };
                slotsToRefresh.push(slot);
              }
            }
            setPhotos(restoredPhotos);

            // Re-fetch fresh signed preview URLs from authorized Server Action
            slotsToRefresh.forEach(async (slot) => {
              try {
                const res = await refreshPhotoSignedUrlAction(appointment.id, slot);
                if (res.success && res.signedUrl) {
                  setPhotos((prev) => {
                    const current = prev[slot];
                    if (!current) return prev;
                    return {
                      ...prev,
                      [slot]: {
                        ...current,
                        signedUrl: res.signedUrl,
                      },
                    };
                  });
                }
              } catch {
                // Background refresh error is non-fatal; preview fallback button allows re-fetch
              }
            });
          }
          if (parsed.updatedAt) {
            setLastSaved(parsed.updatedAt);
          }
          setHasRestoredDraft(true);
          showToast('Đã khôi phục bản nháp số đo & ảnh từ thiết bị.');
        }
      } catch (e) {
        console.error('Failed to restore draft from localStorage:', e);
      }
    }, 0);

    return () => clearTimeout(timer);
  }, [appointment.id, storageKey]);

  // 2. Auto-save to localStorage on change
  const saveDraft = useCallback(
    (
      m: Partial<MeasurementData>,
      s: Partial<SiteConditionData>,
      p: Record<string, SurveyPhotoPreview>
    ) => {
      try {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('vi-VN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        const draft = serializeSurveyDraft(appointment.id, m, s, p, timeStr);
        localStorage.setItem(storageKey, JSON.stringify(draft));
        setLastSaved(timeStr);
      } catch (e) {
        console.error('Failed to save draft to localStorage:', e);
      }
    },
    [appointment.id, storageKey]
  );

  const handleMeasurementChange = (updated: Partial<MeasurementData>) => {
    setMeasurements(updated);
    saveDraft(updated, siteCondition, photos);
    // Clear errors if present
    if (errors.clear_width_mm && updated.clear_width_mm && updated.clear_width_mm > 0) {
      setErrors((prev) => ({ ...prev, clear_width_mm: '' }));
    }
    if (errors.barrier_height_mm && updated.barrier_height_mm && updated.barrier_height_mm > 0) {
      setErrors((prev) => ({ ...prev, barrier_height_mm: '' }));
    }
    if (
      errors.anticipated_flood_height_mm &&
      updated.anticipated_flood_height_mm &&
      updated.anticipated_flood_height_mm > 0
    ) {
      setErrors((prev) => ({ ...prev, anticipated_flood_height_mm: '' }));
    }
  };

  const handleSiteConditionChange = (updated: Partial<SiteConditionData>) => {
    setSiteCondition(updated);
    saveDraft(measurements, updated, photos);
  };

  const handlePhotosChange = (updatedPhotos: Record<string, SurveyPhotoPreview>) => {
    setPhotos(updatedPhotos);
    saveDraft(measurements, siteCondition, updatedPhotos);
    if (errors.photos) {
      setErrors((prev) => ({ ...prev, photos: '' }));
    }
    showToast('Đã lưu ảnh khảo sát.');
  };

  // Reset Draft
  const handleClearDraft = () => {
    if (confirm('Bạn có chắc chắn muốn xóa dữ liệu bản nháp và nhập lại từ đầu?')) {
      localStorage.removeItem(storageKey);
      setMeasurements({
        clear_width_mm: undefined,
        barrier_height_mm: undefined,
        anticipated_flood_height_mm: undefined,
        width_top_mm: undefined,
        width_bottom_mm: undefined,
        gate_type: undefined,
        mounting_method: undefined,
      });
      setSiteCondition({
        wall_material: undefined,
        floor_material: undefined,
        floor_evenness: undefined,
        slope_grade: undefined,
        notes: '',
      });
      setPhotos({});
      setLastSaved(null);
      setHasRestoredDraft(false);
      showToast('Đã xóa dữ liệu nháp.');
    }
  };

  // Count mandatory photos
  const hasOverviewPhoto = !!photos['OVERVIEW']?.slot;
  const hasBottomLeftPhoto = !!photos['BOTTOM_LEFT']?.slot;
  const hasBottomRightPhoto = !!photos['BOTTOM_RIGHT']?.slot;
  const mandatoryPhotoCount =
    (hasOverviewPhoto ? 1 : 0) + (hasBottomLeftPhoto ? 1 : 0) + (hasBottomRightPhoto ? 1 : 0);
  const isPhotosValid = mandatoryPhotoCount === 3;

  // Validate form
  const validate = () => {
    const errs = validateSurveyInput({ appointmentId: appointment.id, measurements, siteCondition }).errors;
    if (!isPhotosValid) {
      errs.photos = 'Vui lòng chụp đủ 3 ảnh bắt buộc (Toàn cảnh, Chân trái, Chân phải).';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleNext = () => {
    if (activeTab === 'MEASURE') {
      setActiveTab('SITE');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (activeTab === 'SITE') {
      setActiveTab('PHOTOS');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (activeTab === 'PHOTOS') {
      setActiveTab('SUMMARY');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  // Submit survey and commit to Supabase
  const handleCompleteSurvey = async () => {
    if (!validate()) {
      showToast('Vui lòng kiểm tra lại các trường thông tin hoặc ảnh còn thiếu.');
      return;
    }

    if (
      !confirm(
        'Bạn có chắc chắn muốn chốt hoàn tất khảo sát? Dữ liệu kích thước và ảnh hiện trường sẽ được khóa và chuyển giao cho bộ phận tính giá (TV7).'
      )
    ) {
      return;
    }

    setIsSubmitting(true);
    setSubmissionErrors([]);

    try {
      const res = await completeSurveyAction({
        appointmentId: appointment.id,
        measurements,
        siteCondition,
        notes: siteCondition.notes,
      });

      if (!res.success) {
        const errList: string[] = [];
        if (res.errors) {
          errList.push(...Object.values(res.errors));
        } else if (res.message) {
          errList.push(res.message);
        }
        setSubmissionErrors(errList);
        showToast('Không thể hoàn tất: Dữ liệu chưa đạt điều kiện.');
        return;
      }

      // Success: clean localStorage draft
      localStorage.removeItem(storageKey);
      showToast('Khảo sát hoàn tất thành công! Đang chuyển về danh sách...');

      setTimeout(() => {
        router.push('/surveys');
      }, 1000);
    } catch (err) {
      setSubmissionErrors([
        err instanceof Error ? err.message : 'Lỗi hệ thống không xác định khi hoàn tất khảo sát.',
      ]);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-28">
      {/* Toast */}
      {toastMessage && (
        <div className="fixed top-4 right-4 z-50 px-4 py-3 rounded-xl bg-surface-primary border border-accent text-accent text-xs shadow-lg flex items-center gap-2 animate-in fade-in">
          <span>💾</span>
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Navigation Breadcrumb */}
      <div className="flex items-center justify-between">
        <Link
          href="/surveys"
          className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition font-medium"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          <span>Quay lại danh sách</span>
        </Link>

        {/* Offline Draft Status Indicator */}
        <div className="flex items-center gap-2">
          {lastSaved && (
            <span className="text-[11px] text-emerald-600 flex items-center gap-1 font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span>Đã lưu nháp: {lastSaved}</span>
            </span>
          )}
          {hasRestoredDraft && (
            <button
              type="button"
              onClick={handleClearDraft}
              className="text-[11px] text-danger hover:underline"
            >
              Xóa nháp
            </button>
          )}
        </div>
      </div>

      {/* Customer Header Card (STRICT: ZERO PHONE) */}
      <div className="p-4 sm:p-5 rounded-xl bg-surface-primary border border-border-subtle space-y-3 shadow-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-accent-soft text-accent flex items-center justify-center font-bold text-sm">
              {customer.name.charAt(0)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-text-primary">{customer.name}</span>
                <span className="px-2 py-0.5 rounded bg-surface-secondary text-accent font-mono text-xs font-semibold border border-border-subtle">
                  {customer.customer_code}
                </span>
              </div>
              <div className="text-xs text-text-secondary flex items-center gap-1.5 mt-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                <span>Trạng thái: Đang khảo sát hiện trường ({appointment.status})</span>
              </div>
            </div>
          </div>
        </div>

        {/* Address */}
        <div className="p-3 rounded-lg bg-surface-secondary border border-border-subtle text-xs text-text-secondary flex items-start gap-2">
          <svg className="w-4 h-4 text-text-tertiary shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span className="font-medium leading-relaxed">{appointment.address}</span>
        </div>
      </div>

      {/* Mobile Step Navigation Tabs */}
      <div className="grid grid-cols-4 gap-1.5 p-1.5 bg-surface-secondary border border-border-subtle rounded-xl">
        <button
          type="button"
          onClick={() => setActiveTab('MEASURE')}
          className={`py-2 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1 ${
            activeTab === 'MEASURE'
              ? 'bg-surface-primary text-text-primary shadow-xs'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          <span>1. Số đo</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('SITE')}
          className={`py-2 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1 ${
            activeTab === 'SITE'
              ? 'bg-surface-primary text-text-primary shadow-xs'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          <span>2. Hiện trạng</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('PHOTOS')}
          className={`py-2 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1 ${
            activeTab === 'PHOTOS'
              ? 'bg-surface-primary text-text-primary shadow-xs'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          <span>3. Ảnh</span>
          <span
            className={`text-[10px] px-1 py-0.2 rounded-full font-mono font-bold ${
              isPhotosValid ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
            }`}
          >
            {mandatoryPhotoCount}/3
          </span>
        </button>
        <button
          type="button"
          onClick={() => {
            validate();
            setActiveTab('SUMMARY');
          }}
          className={`py-2 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1 ${
            activeTab === 'SUMMARY'
              ? 'bg-surface-primary text-text-primary shadow-xs'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          <span>4. Tổng kết</span>
        </button>
      </div>

      {/* Main Tab Views */}
      <div className="p-4 sm:p-6 bg-surface-primary border border-border-subtle rounded-xl shadow-xs">
        {activeTab === 'MEASURE' && (
          <MeasurementForm
            values={measurements}
            onChange={handleMeasurementChange}
            errors={errors}
          />
        )}

        {activeTab === 'SITE' && (
          <SiteConditionSelector
            values={siteCondition}
            onChange={handleSiteConditionChange}
            errors={errors}
          />
        )}

        {activeTab === 'PHOTOS' && (
          <div className="space-y-4">
            <PhotoCaptureGrid
              appointmentId={appointment.id}
              photos={photos}
              onChange={handlePhotosChange}
            />

            {errors.photos && (
              <div className="p-3 rounded-xl bg-rose-950/70 border border-rose-500/40 text-rose-300 text-xs flex items-center gap-2">
                <span className="font-bold text-rose-400 text-sm">!</span>
                <span>{errors.photos}</span>
              </div>
            )}
          </div>
        )}

        {activeTab === 'SUMMARY' && (
          <div className="space-y-6">
            <div className="border-b border-border-subtle pb-3">
              <h2 className="text-base font-semibold text-text-primary">Kiểm Tra Dữ Liệu Kỹ Thuật Đã Nhập</h2>
              <p className="text-xs text-text-secondary">
                Đảm bảo đủ thông số kỹ thuật và ảnh hiện trường để bộ phận Giá (TV7) tính giá theo khung chuẩn.
              </p>
            </div>

            {/* Submission Error Banner */}
            {submissionErrors.length > 0 && (
              <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs space-y-2">
                <div className="font-semibold flex items-center gap-1.5 text-danger">
                  <span>⚠</span>
                  <span>Chưa đủ điều kiện hoàn tất khảo sát:</span>
                </div>
                <ul className="list-disc list-inside space-y-1 text-rose-700 pl-1">
                  {submissionErrors.map((err, idx) => (
                    <li key={idx}>{err}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Pricing Readiness Check */}
            <div className="p-4 rounded-xl bg-surface-secondary border border-border-subtle space-y-3">
              <div className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                1. Thông số kích thước
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                <div className="p-2.5 rounded-lg bg-surface-primary border border-border-subtle">
                  <span className="text-text-tertiary block">Rộng lọt lòng:</span>
                  <span className="text-base font-bold font-mono text-text-primary">
                    {measurements.clear_width_mm ? `${measurements.clear_width_mm} mm` : 'Chưa nhập'}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-surface-primary border border-border-subtle">
                  <span className="text-text-tertiary block">Cao chắn đề xuất:</span>
                  <span className="text-base font-bold font-mono text-text-primary">
                    {measurements.barrier_height_mm ? `${measurements.barrier_height_mm} mm` : 'Chưa nhập'}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-surface-primary border border-border-subtle">
                  <span className="text-text-tertiary block">Cao độ ngập:</span>
                  <span className="text-base font-bold font-mono text-accent">
                    {measurements.anticipated_flood_height_mm !== undefined
                      ? `${measurements.anticipated_flood_height_mm} mm`
                      : 'Chưa nhập'}
                  </span>
                </div>
              </div>

              {measurements.width_top_mm && measurements.width_bottom_mm && (
                <div className="p-2.5 rounded-lg bg-surface-primary border border-border-subtle text-xs flex justify-between">
                  <span className="text-text-secondary">Khẩu độ Đỉnh / Đáy:</span>
                  <span className="font-mono text-text-primary font-medium">
                    {measurements.width_top_mm} mm / {measurements.width_bottom_mm} mm (Chênh lệch:{' '}
                    {Math.abs(measurements.width_top_mm - measurements.width_bottom_mm)} mm)
                  </span>
                </div>
              )}
            </div>

            {/* Site Condition Summary */}
            <div className="p-4 rounded-xl bg-surface-secondary border border-border-subtle space-y-3">
              <div className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                2. Hiện trạng công trình
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="p-2.5 rounded-lg bg-surface-primary border border-border-subtle">
                  <span className="text-text-tertiary block">Vật liệu tường:</span>
                  <span className="font-semibold text-text-primary">{siteCondition.wall_material}</span>
                </div>
                <div className="p-2.5 rounded-lg bg-surface-primary border border-border-subtle">
                  <span className="text-text-tertiary block">Vật liệu sàn:</span>
                  <span className="font-semibold text-text-primary">{siteCondition.floor_material}</span>
                </div>
                <div className="p-2.5 rounded-lg bg-surface-primary border border-border-subtle">
                  <span className="text-text-tertiary block">Độ phẳng sàn:</span>
                  <span className="font-semibold text-text-primary">{siteCondition.floor_evenness}</span>
                </div>
                <div className="p-2.5 rounded-lg bg-surface-primary border border-border-subtle">
                  <span className="text-text-tertiary block">Hướng dốc sàn:</span>
                  <span className="font-semibold text-text-primary">{siteCondition.slope_grade}</span>
                </div>
              </div>

              {siteCondition.notes && (
                <div className="p-2.5 rounded-lg bg-surface-primary border border-border-subtle text-xs text-text-secondary">
                  <span className="text-text-tertiary block mb-1">Ghi chú:</span>
                  <span>{siteCondition.notes}</span>
                </div>
              )}
            </div>

            {/* Photos Summary Section */}
            <div className="p-4 rounded-xl bg-surface-secondary border border-border-subtle space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                  3. Ảnh hiện trường khảo sát ({mandatoryPhotoCount}/3 ảnh bắt buộc)
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('PHOTOS')}
                  className="text-xs text-accent hover:underline font-medium"
                >
                  Chỉnh sửa ảnh
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2 sm:gap-3">
                {/* 1. Overview */}
                <div className="p-2 rounded-lg bg-surface-primary border border-border-subtle space-y-1.5 text-center">
                  <span className="text-[11px] font-medium text-text-secondary block truncate">
                    1. Toàn cảnh
                  </span>
                  {photos['OVERVIEW']?.signedUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={photos['OVERVIEW'].signedUrl}
                      alt="Toàn cảnh"
                      className="w-full aspect-video object-cover rounded-md border border-border-subtle"
                    />
                  ) : (
                    <div className="w-full aspect-video rounded-md bg-surface-secondary border border-dashed border-rose-300 flex items-center justify-center text-[10px] text-danger font-medium">
                      Thiếu ảnh
                    </div>
                  )}
                </div>

                {/* 2. Bottom Left */}
                <div className="p-2 rounded-lg bg-surface-primary border border-border-subtle space-y-1.5 text-center">
                  <span className="text-[11px] font-medium text-text-secondary block truncate">
                    2. Chân trái
                  </span>
                  {photos['BOTTOM_LEFT']?.signedUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={photos['BOTTOM_LEFT'].signedUrl}
                      alt="Chân tường trái"
                      className="w-full aspect-video object-cover rounded-md border border-border-subtle"
                    />
                  ) : (
                    <div className="w-full aspect-video rounded-md bg-surface-secondary border border-dashed border-rose-300 flex items-center justify-center text-[10px] text-danger font-medium">
                      Thiếu ảnh
                    </div>
                  )}
                </div>

                {/* 3. Bottom Right */}
                <div className="p-2 rounded-lg bg-surface-primary border border-border-subtle space-y-1.5 text-center">
                  <span className="text-[11px] font-medium text-text-secondary block truncate">
                    3. Chân phải
                  </span>
                  {photos['BOTTOM_RIGHT']?.signedUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={photos['BOTTOM_RIGHT'].signedUrl}
                      alt="Chân tường phải"
                      className="w-full aspect-video object-cover rounded-md border border-border-subtle"
                    />
                  ) : (
                    <div className="w-full aspect-video rounded-md bg-surface-secondary border border-dashed border-rose-300 flex items-center justify-center text-[10px] text-danger font-medium">
                      Thiếu ảnh
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Readiness Banner for TV7 */}
            {isPhotosValid ? (
              <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs space-y-3">
                <div className="space-y-1">
                  <div className="font-semibold flex items-center gap-1.5 text-emerald-900">
                    <span>✓</span>
                    <span>Hồ sơ số đo & ảnh hiện trường đã đầy đủ điều kiện</span>
                  </div>
                  <p className="text-emerald-700">
                    Đầy đủ dữ liệu kích thước lọt lòng, hiện trạng mặt bằng và 3 góc ảnh bắt buộc để bộ phận tính giá (TV7) áp khung giá chính thức.
                  </p>
                </div>

                {/* Main Action Submit Button */}
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={handleCompleteSurvey}
                  className="w-full py-2.5 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs shadow-xs transition flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <>
                      <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                      <span>Đang nộp hồ sơ khảo sát...</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span>Xác nhận hoàn tất khảo sát & Gửi dữ liệu tính giá</span>
                    </>
                  )}
                </button>
              </div>
            ) : (
              <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs space-y-2">
                <div className="font-semibold flex items-center gap-1.5 text-amber-900">
                  <span>⚠</span>
                  <span>Chưa đủ 3 ảnh hiện trường bắt buộc ({mandatoryPhotoCount}/3)</span>
                </div>
                <p className="text-amber-700">
                  Vui lòng chụp đủ ảnh toàn cảnh, chân tường trái và chân tường phải để hoàn tất hồ sơ đo đạc.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveTab('PHOTOS')}
                  className="px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white font-medium text-xs transition"
                >
                  Chụp ảnh ngay
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sticky Bottom Action Bar for Mobile Thumb Navigation */}
      <div className="fixed bottom-0 left-0 right-0 p-3 bg-surface-primary/95 backdrop-blur border-t border-border-subtle z-40 shadow-sm">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="text-xs text-text-tertiary font-mono hidden sm:block">
            {lastSaved ? `Nháp: ${lastSaved}` : 'Chưa lưu nháp'}
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            {activeTab !== 'MEASURE' && (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => {
                  if (activeTab === 'SITE') setActiveTab('MEASURE');
                  if (activeTab === 'PHOTOS') setActiveTab('SITE');
                  if (activeTab === 'SUMMARY') setActiveTab('PHOTOS');
                }}
                className="px-4 py-2 rounded-lg bg-surface-secondary hover:bg-surface-hover text-text-primary font-medium text-xs transition border border-border-subtle disabled:opacity-50"
              >
                Quay lại
              </button>
            )}

            {activeTab !== 'SUMMARY' ? (
              <button
                type="button"
                onClick={handleNext}
                className="flex-1 sm:flex-initial px-5 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white font-medium text-xs transition flex items-center justify-center gap-1.5"
              >
                <span>Tiếp tục</span>
                <span>→</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={isSubmitting || !isPhotosValid}
                onClick={handleCompleteSurvey}
                className={`flex-1 sm:flex-initial px-5 py-2 rounded-lg font-medium text-xs transition flex items-center justify-center gap-1.5 ${
                  isPhotosValid
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs'
                    : 'bg-surface-secondary text-text-tertiary cursor-not-allowed border border-border-subtle'
                } disabled:opacity-50`}
              >
                {isSubmitting ? (
                  <>
                    <div className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
                    <span>Đang nộp...</span>
                  </>
                ) : (
                  <span>✓ Hoàn tất khảo sát</span>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


