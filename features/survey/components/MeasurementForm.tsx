'use client';

import React from 'react';
import type { MeasurementData, GateType, MountingMethod } from '../types/survey';

interface MeasurementFormProps {
  values: Partial<MeasurementData>;
  onChange: (updated: Partial<MeasurementData>) => void;
  errors?: Record<string, string>;
}

export default function MeasurementForm({
  values,
  onChange,
  errors = {},
}: MeasurementFormProps) {
  const clearWidth = values.clear_width_mm ?? '';
  const barrierHeight = values.barrier_height_mm ?? '';
  const floodHeight = values.anticipated_flood_height_mm ?? '';
  const widthTop = values.width_top_mm ?? '';
  const widthBottom = values.width_bottom_mm ?? '';
  const gateType = values.gate_type || 'REMOVABLE_PANEL';
  const mountingMethod = values.mounting_method || 'INSIDE_JAMB';

  // Helper to adjust number field with step
  const handleStep = (field: keyof MeasurementData, step: number, min = 0) => {
    const current = Number(values[field] ?? 0);
    const updated = Math.max(min, current + step);
    onChange({ ...values, [field]: updated });
  };

  // Difference in top/bottom width
  const wallDifference =
    typeof widthTop === 'number' && typeof widthBottom === 'number' && widthTop > 0 && widthBottom > 0
      ? Math.abs(widthTop - widthBottom)
      : null;

  // Warning when flood height exceeds barrier height
  const isFloodOverBarrier =
    typeof barrierHeight === 'number' &&
    typeof floodHeight === 'number' &&
    barrierHeight > 0 &&
    floodHeight > 0 &&
    floodHeight > barrierHeight;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-400 font-bold text-sm">
            1
          </div>
          <div>
            <h2 className="text-base font-bold text-white">Kích Thước Cửa & Cao Độ Ngập</h2>
            <p className="text-xs text-slate-400">Đơn vị đo lường bắt buộc: milimét (mm)</p>
          </div>
        </div>
        <span className="text-xs font-mono text-slate-500">* Bắt buộc &gt; 0</span>
      </div>

      {/* Field 1: Chiều rộng lọt lòng (clear_width_mm) */}
      <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800/90 space-y-3">
        <div className="flex items-center justify-between">
          <label htmlFor="clear_width_mm" className="text-sm font-semibold text-white flex items-center gap-1.5">
            <span>Chiều rộng lọt lòng cửa (W)</span>
            <span className="text-rose-400">*</span>
          </label>
          <span className="text-xs font-mono text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">
            mm
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleStep('clear_width_mm', -50, 100)}
            className="w-12 h-12 rounded-xl bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-white font-bold text-lg flex items-center justify-center shrink-0 transition"
            title="Giảm 50mm"
          >
            -50
          </button>
          <button
            type="button"
            onClick={() => handleStep('clear_width_mm', -10, 100)}
            className="w-12 h-12 rounded-xl bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-white font-bold text-sm flex items-center justify-center shrink-0 transition"
            title="Giảm 10mm"
          >
            -10
          </button>

          <input
            id="clear_width_mm"
            type="number"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="Ví dụ: 1200"
            value={clearWidth}
            onChange={(e) => {
              const val = e.target.value === '' ? '' : Number(e.target.value);
              onChange({ ...values, clear_width_mm: val as number });
            }}
            className={`flex-1 h-12 text-center text-lg font-bold font-mono bg-slate-950 border rounded-xl text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition ${
              errors.clear_width_mm ? 'border-rose-500 bg-rose-950/20' : 'border-slate-700'
            }`}
          />

          <button
            type="button"
            onClick={() => handleStep('clear_width_mm', 10)}
            className="w-12 h-12 rounded-xl bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-white font-bold text-sm flex items-center justify-center shrink-0 transition"
            title="Tăng 10mm"
          >
            +10
          </button>
          <button
            type="button"
            onClick={() => handleStep('clear_width_mm', 50)}
            className="w-12 h-12 rounded-xl bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-white font-bold text-lg flex items-center justify-center shrink-0 transition"
            title="Tăng 50mm"
          >
            +50
          </button>
        </div>

        {errors.clear_width_mm && (
          <p className="text-xs text-rose-400 font-medium">{errors.clear_width_mm}</p>
        )}
      </div>

      {/* Field 2: Chiều cao chắn đề xuất (barrier_height_mm) */}
      <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800/90 space-y-3">
        <div className="flex items-center justify-between">
          <label htmlFor="barrier_height_mm" className="text-sm font-semibold text-white flex items-center gap-1.5">
            <span>Chiều cao tấm chắn đề xuất (H)</span>
            <span className="text-rose-400">*</span>
          </label>
          <span className="text-xs font-mono text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">
            mm
          </span>
        </div>

        {/* Quick Height Presets Chips */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <span className="text-xs text-slate-500 shrink-0">Chuẩn:</span>
          {[400, 500, 600, 700, 800, 1000].map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => onChange({ ...values, barrier_height_mm: h })}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition shrink-0 ${
                barrierHeight === h
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {h}mm
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleStep('barrier_height_mm', -50, 100)}
            className="w-12 h-12 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold text-lg flex items-center justify-center shrink-0 transition"
          >
            -50
          </button>
          <input
            id="barrier_height_mm"
            type="number"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="Ví dụ: 600"
            value={barrierHeight}
            onChange={(e) => {
              const val = e.target.value === '' ? '' : Number(e.target.value);
              onChange({ ...values, barrier_height_mm: val as number });
            }}
            className={`flex-1 h-12 text-center text-lg font-bold font-mono bg-slate-950 border rounded-xl text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition ${
              errors.barrier_height_mm ? 'border-rose-500 bg-rose-950/20' : 'border-slate-700'
            }`}
          />
          <button
            type="button"
            onClick={() => handleStep('barrier_height_mm', 50)}
            className="w-12 h-12 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold text-lg flex items-center justify-center shrink-0 transition"
          >
            +50
          </button>
        </div>

        {errors.barrier_height_mm && (
          <p className="text-xs text-rose-400 font-medium">{errors.barrier_height_mm}</p>
        )}
      </div>

      {/* Field 3: Cao độ ngập dự kiến (anticipated_flood_height_mm) */}
      <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800/90 space-y-3">
        <div className="flex items-center justify-between">
          <label htmlFor="anticipated_flood_height_mm" className="text-sm font-semibold text-white flex items-center gap-1.5">
            <span>Cao độ ngập dự kiến / Đỉnh ngập lịch sử</span>
            <span className="text-rose-400">*</span>
          </label>
          <span className="text-xs font-mono text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded">
            mm
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleStep('anticipated_flood_height_mm', -50, 0)}
            className="w-12 h-12 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold text-lg flex items-center justify-center shrink-0 transition"
          >
            -50
          </button>
          <input
            id="anticipated_flood_height_mm"
            type="number"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="Mức nước dâng tính từ nền (mm)"
            value={floodHeight}
            onChange={(e) => {
              const val = e.target.value === '' ? '' : Number(e.target.value);
              onChange({ ...values, anticipated_flood_height_mm: val as number });
            }}
            className={`flex-1 h-12 text-center text-lg font-bold font-mono bg-slate-950 border rounded-xl text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500 transition ${
              errors.anticipated_flood_height_mm ? 'border-rose-500 bg-rose-950/20' : 'border-slate-700'
            }`}
          />
          <button
            type="button"
            onClick={() => handleStep('anticipated_flood_height_mm', 50)}
            className="w-12 h-12 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold text-lg flex items-center justify-center shrink-0 transition"
          >
            +50
          </button>
        </div>

        {/* Warning if flood height > barrier height */}
        {isFloodOverBarrier && (
          <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-500/50 text-amber-200 text-xs flex items-start gap-2">
            <span className="text-base leading-none">⚠</span>
            <span>
              <strong>Cảnh báo tràn đỉnh:</strong> Mức ngập dự kiến ({floodHeight}mm) cao hơn chiều
              cao chắn đề xuất ({barrierHeight}mm). Nên tăng chiều cao tấm chắn để đảm bảo an toàn.
            </span>
          </div>
        )}

        {errors.anticipated_flood_height_mm && (
          <p className="text-xs text-rose-400 font-medium">{errors.anticipated_flood_height_mm}</p>
        )}
      </div>

      {/* Field 4: Kiểm tra độ lệch má tường trên / dưới */}
      <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800/90 space-y-3">
        <div>
          <div className="text-sm font-semibold text-white flex items-center justify-between">
            <span>Kiểm tra độ xiên má tường hai bên</span>
            <span className="text-xs text-slate-400 font-normal">Đo đỉnh &amp; đáy</span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Đo khoảng cách má tường ở vị trí trên đỉnh và dưới sát sàn để phát hiện độ xiên/lệch.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="width_top_mm" className="block text-xs font-medium text-slate-300 mb-1.5">
              Khẩu độ Đỉnh (Top)
            </label>
            <input
              id="width_top_mm"
              type="number"
              inputMode="numeric"
              placeholder="VD: 1205 mm"
              value={widthTop}
              onChange={(e) => {
                const val = e.target.value === '' ? '' : Number(e.target.value);
                onChange({ ...values, width_top_mm: val as number });
              }}
              className="w-full h-12 text-center text-sm font-bold font-mono bg-slate-950 border border-slate-700 rounded-xl text-white placeholder-slate-600 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label htmlFor="width_bottom_mm" className="block text-xs font-medium text-slate-300 mb-1.5">
              Khẩu độ Đáy (Bottom)
            </label>
            <input
              id="width_bottom_mm"
              type="number"
              inputMode="numeric"
              placeholder="VD: 1200 mm"
              value={widthBottom}
              onChange={(e) => {
                const val = e.target.value === '' ? '' : Number(e.target.value);
                onChange({ ...values, width_bottom_mm: val as number });
              }}
              className="w-full h-12 text-center text-sm font-bold font-mono bg-slate-950 border border-slate-700 rounded-xl text-white placeholder-slate-600 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* Tolerance status alert */}
        {wallDifference !== null && (
          <div
            className={`p-3 rounded-xl border text-xs flex items-center justify-between ${
              wallDifference > 5
                ? 'bg-amber-950/40 border-amber-500/50 text-amber-200'
                : 'bg-emerald-950/40 border-emerald-500/50 text-emerald-200'
            }`}
          >
            <span>
              Độ chênh lệch má tường: <strong>{wallDifference} mm</strong>
            </span>
            <span>
              {wallDifference > 5
                ? '⚠ &gt; 5mm: Cần nẹp chêm bù dốc'
                : '✓ Chuẩn (&lt;= 5mm)'}
            </span>
          </div>
        )}
      </div>

      {/* Field 5: Loại cửa & Phương án lắp ray */}
      <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800/90 space-y-4">
        <div>
          <label className="block text-sm font-semibold text-white mb-2">Loại cửa chống ngập</label>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { id: 'REMOVABLE_PANEL', label: 'Tấm nhôm tháo lắp' },
                { id: 'AUTOMATIC_HYDRAULIC', label: 'Tự động thủy lực' },
                { id: 'ROLL_UP_CANVAS', label: 'Cuộn bạt lò xo' },
                { id: 'SWING_GATE', label: 'Cánh mở nén ép' },
              ] as const
            ).map((gate) => (
              <button
                key={gate.id}
                type="button"
                onClick={() => onChange({ ...values, gate_type: gate.id as GateType })}
                className={`p-3 rounded-xl text-xs font-semibold text-left transition border ${
                  gateType === gate.id
                    ? 'bg-blue-600 border-blue-400 text-white shadow-sm'
                    : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                }`}
              >
                {gate.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-white mb-2">Vị trí gắn ray dẫn hướng</label>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { id: 'INSIDE_JAMB', label: 'Trong lòng khung' },
                { id: 'OUTSIDE_FACE', label: 'Mặt ngoài tường' },
                { id: 'INSIDE_FACE', label: 'Mặt trong nhà' },
              ] as const
            ).map((mount) => (
              <button
                key={mount.id}
                type="button"
                onClick={() => onChange({ ...values, mounting_method: mount.id as MountingMethod })}
                className={`p-2.5 rounded-xl text-xs font-semibold text-center transition border ${
                  mountingMethod === mount.id
                    ? 'bg-indigo-600 border-indigo-400 text-white shadow-sm'
                    : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                }`}
              >
                {mount.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
