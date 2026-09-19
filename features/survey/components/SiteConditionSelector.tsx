'use client';

import React from 'react';
import type {
  SiteConditionData,
  WallMaterial,
  FloorMaterial,
  FloorEvenness,
  SlopeGrade,
} from '../types/survey';

interface SiteConditionSelectorProps {
  values: Partial<SiteConditionData>;
  onChange: (updated: Partial<SiteConditionData>) => void;
  errors?: Record<string, string>;
}

export default function SiteConditionSelector({
  values,
  onChange,
  errors = {},
}: SiteConditionSelectorProps) {
  const selectedWall = values.wall_material || 'SOLID_BRICK';
  const selectedFloor = values.floor_material || 'CONCRETE_SMOOTH';
  const selectedEvenness = values.floor_evenness || 'FLAT';
  const selectedSlope = values.slope_grade || 'SLOPING_OUT';
  const notes = values.notes || '';

  const wallOptions: Array<{ id: WallMaterial; label: string; desc: string; icon: string }> = [
    {
      id: 'SOLID_BRICK',
      label: 'Gạch đặc',
      desc: 'Khoan nở sắt chuẩn',
      icon: '🧱',
    },
    {
      id: 'HOLLOW_BRICK',
      label: 'Gạch ống rỗng',
      desc: 'Cần bu lông hóa chất',
      icon: '🕳',
    },
    {
      id: 'CONCRETE',
      label: 'Bê tông cốt thép',
      desc: 'Chịu lực tối đa, tiêu chuẩn',
      icon: '🏗',
    },
    {
      id: 'STEEL_FRAME',
      label: 'Khung thép / sắt hộp',
      desc: 'Hàn hoặc bắt vít tự khoan',
      icon: '🔩',
    },
    {
      id: 'ALUMINUM_GLASS',
      label: 'Nhôm kính / Vách kính',
      desc: 'Cần gia cố trụ phụ',
      icon: '🪟',
    },
    {
      id: 'STONE_TILES',
      label: 'Tường ốp đá / Granite',
      desc: 'Cần mũi khoan rút lõi đá',
      icon: '🪨',
    },
  ];

  const floorOptions: Array<{ id: FloorMaterial; label: string; icon: string }> = [
    { id: 'CONCRETE_SMOOTH', label: 'Bê tông phẳng', icon: '◻' },
    { id: 'TILES', label: 'Gạch men lát sàn', icon: '▦' },
    { id: 'NATURAL_STONE', label: 'Đá tự nhiên / Hoa cương', icon: '🪨' },
    { id: 'ROUGH_CEMENT', label: 'Xi măng thô ráp', icon: '░' },
    { id: 'PAVING_BRICK', label: 'Gạch lát vỉa hè / Terrazzo', icon: '🧱' },
  ];

  const evennessOptions: Array<{
    id: FloorEvenness;
    label: string;
    desc: string;
    badgeColor: string;
  }> = [
    {
      id: 'FLAT',
      label: 'Phẳng chuẩn (< 2mm)',
      desc: 'Gioăng ép tiêu chuẩn kín khít',
      badgeColor: 'border-emerald-500/40 text-emerald-300',
    },
    {
      id: 'SLIGHTLY_UNEVEN',
      label: 'Lệch nhẹ (2 - 5 mm)',
      desc: 'Sử dụng gioăng xốp EPDM dày',
      badgeColor: 'border-amber-500/40 text-amber-300',
    },
    {
      id: 'HIGHLY_UNEVEN',
      label: 'Gồ ghề (> 5 mm)',
      desc: 'Bắt buộc chèn nẹp ray âm sàn',
      badgeColor: 'border-rose-500/40 text-rose-300',
    },
  ];

  const slopeOptions: Array<{ id: SlopeGrade; label: string; desc: string; icon: string }> = [
    {
      id: 'SLOPING_OUT',
      label: 'Dốc ra ngoài đường',
      desc: 'Tốt nhất, nước tự thoát',
      icon: '↘',
    },
    {
      id: 'LEVEL',
      label: 'Thăng bằng (Ngang cốt)',
      desc: 'Tiêu chuẩn chống ngập',
      icon: '→',
    },
    {
      id: 'SLOPING_IN',
      label: 'Dốc ngược vào nhà',
      desc: 'Cần gờ phụ chặn đáy',
      icon: '↙',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold text-sm">
            2
          </div>
          <div>
            <h2 className="text-base font-bold text-white">Hiện Trạng Tường &amp; Nền Sàn</h2>
            <p className="text-xs text-slate-400">Chọn nhanh các điều kiện thực tế tại vị trí lắp đặt</p>
          </div>
        </div>
        <span className="text-xs font-mono text-slate-500">* Bắt buộc</span>
      </div>

      {/* 1. Vật liệu tường */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-sm font-semibold text-white flex items-center gap-1.5">
            <span>Vật liệu tường bắt ray hai bên</span>
            <span className="text-rose-400">*</span>
          </label>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {wallOptions.map((opt) => {
            const isSelected = selectedWall === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChange({ ...values, wall_material: opt.id })}
                className={`p-3 rounded-2xl text-left transition-all border flex flex-col justify-between gap-1.5 ${
                  isSelected
                    ? 'bg-blue-600/20 border-blue-500 shadow-md shadow-blue-500/10'
                    : 'bg-slate-900/90 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-lg">{opt.icon}</span>
                  <span
                    className={`w-4 h-4 rounded-full border flex items-center justify-center text-[10px] ${
                      isSelected ? 'border-blue-400 bg-blue-500 text-white' : 'border-slate-600'
                    }`}
                  >
                    {isSelected && '✓'}
                  </span>
                </div>
                <div>
                  <div className={`text-xs font-bold ${isSelected ? 'text-white' : 'text-slate-200'}`}>
                    {opt.label}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">{opt.desc}</div>
                </div>
              </button>
            );
          })}
        </div>

        {selectedWall === 'HOLLOW_BRICK' && (
          <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-500/40 text-amber-200 text-xs">
            💡 <strong>Lưu ý kỹ thuật:</strong> Tường gạch rỗng cần chuẩn bị bu lông nở hóa chất cấy
            thép để đảm bảo lực kéo chống áp lực nước ngập.
          </div>
        )}

        {errors.wall_material && (
          <p className="text-xs text-rose-400 font-medium">{errors.wall_material}</p>
        )}
      </div>

      {/* 2. Vật liệu sàn */}
      <div className="space-y-3">
        <label className="text-sm font-semibold text-white flex items-center gap-1.5">
          <span>Bề mặt sàn đáy cửa</span>
          <span className="text-rose-400">*</span>
        </label>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {floorOptions.map((opt) => {
            const isSelected = selectedFloor === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChange({ ...values, floor_material: opt.id })}
                className={`p-3 rounded-xl text-xs font-semibold text-left transition border flex items-center gap-2 ${
                  isSelected
                    ? 'bg-indigo-600/20 border-indigo-500 text-white'
                    : 'bg-slate-900/90 border-slate-800 text-slate-300 hover:border-slate-700'
                }`}
              >
                <span className="text-sm font-mono text-slate-400">{opt.icon}</span>
                <span className="truncate">{opt.label}</span>
              </button>
            );
          })}
        </div>

        {errors.floor_material && (
          <p className="text-xs text-rose-400 font-medium">{errors.floor_material}</p>
        )}
      </div>

      {/* 3. Độ phẳng mặt sàn */}
      <div className="space-y-3">
        <label className="text-sm font-semibold text-white flex items-center gap-1.5">
          <span>Độ phẳng mặt nền tiếp xúc ray đáy</span>
          <span className="text-rose-400">*</span>
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          {evennessOptions.map((opt) => {
            const isSelected = selectedEvenness === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChange({ ...values, floor_evenness: opt.id })}
                className={`p-3 rounded-xl text-left transition border ${
                  isSelected
                    ? 'bg-slate-800 border-blue-500 shadow-sm'
                    : 'bg-slate-900/90 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-bold ${opt.badgeColor}`}>{opt.label}</span>
                  {isSelected && <span className="text-xs text-blue-400 font-bold">✓</span>}
                </div>
                <p className="text-[11px] text-slate-400 mt-1">{opt.desc}</p>
              </button>
            );
          })}
        </div>

        {selectedEvenness === 'HIGHLY_UNEVEN' && (
          <div className="p-3 rounded-xl bg-rose-950/30 border border-rose-500/40 text-rose-200 text-xs">
            ⚠ <strong>Hiện trường gồ ghề &gt; 5mm:</strong> Cần tư vấn khách cắt rãnh âm sàn chèn ray
            inox phẳng hoặc trát phẳng lại gờ tiếp xúc để gioăng không bị rò rỉ nước.
          </div>
        )}

        {errors.floor_evenness && (
          <p className="text-xs text-rose-400 font-medium">{errors.floor_evenness}</p>
        )}
      </div>

      {/* 4. Hướng dốc thoát nước */}
      <div className="space-y-3">
        <label className="text-sm font-semibold text-white flex items-center gap-1.5">
          <span>Hướng dốc mặt sàn</span>
          <span className="text-rose-400">*</span>
        </label>

        <div className="grid grid-cols-3 gap-2">
          {slopeOptions.map((opt) => {
            const isSelected = selectedSlope === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChange({ ...values, slope_grade: opt.id })}
                className={`p-3 rounded-xl text-center transition border flex flex-col items-center gap-1 ${
                  isSelected
                    ? 'bg-blue-600/20 border-blue-500 text-white'
                    : 'bg-slate-900/90 border-slate-800 text-slate-300 hover:border-slate-700'
                }`}
              >
                <span className="text-base font-bold">{opt.icon}</span>
                <span className="text-xs font-semibold">{opt.label}</span>
                <span className="text-[10px] text-slate-400 hidden sm:block">{opt.desc}</span>
              </button>
            );
          })}
        </div>

        {selectedSlope === 'SLOPING_IN' && (
          <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-500/40 text-amber-200 text-xs">
            💡 <strong>Dốc vào trong nhà:</strong> Cần phương án gờ chặn phụ hoặc gioăng nén kép.
          </div>
        )}

        {errors.slope_grade && (
          <p className="text-xs text-rose-400 font-medium">{errors.slope_grade}</p>
        )}
      </div>

      {/* 5. Ghi chú kỹ thuật */}
      <div className="space-y-2">
        <label htmlFor="site_condition_notes" className="text-sm font-semibold text-white">Ghi chú hiện trường bổ sung</label>
        <textarea
          id="site_condition_notes"
          rows={3}
          value={notes}
          onChange={(e) => onChange({ ...values, notes: e.target.value })}
          placeholder="Mô tả chướng ngại vật, hộp kỹ thuật, đường ống ngầm hoặc yêu cầu riêng của gia chủ..."
          className="w-full p-3 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition resize-none"
        />
      </div>
    </div>
  );
}
