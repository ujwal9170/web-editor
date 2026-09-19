"use client";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Check } from "lucide-react";
import { normalizeHex, colorGrid } from "@/shared/color.mjs";

export default function CustomColor({ value, onChange, label }: {
  value: string; onChange: (value: string) => void; label: string;
}) {
  const [open, setOpen] = useState(false);
  return <div className="custom-color-field">
    <span>{label}</span>
    <button type="button" className="color-picker-trigger" aria-label={`Choose ${label}`} onClick={() => setOpen(true)}>
      <span style={{ background: value }} aria-hidden="true" />{value.toUpperCase()}
    </button>
    {open && createPortal(<ColorSheet value={value} onSave={onChange} onClose={() => setOpen(false)} />, document.body)}
  </div>;
}

function ColorSheet({ value, onSave, onClose }: { value: string; onSave: (c: string) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [selected, setSelected] = useState(value.toUpperCase());
  const [hex, setHex] = useState(value.toUpperCase());
  const [tab, setTab] = useState<"Grid" | "Sliders">("Grid");
  const valid = normalizeHex(hex);
  const rgb = [1, 3, 5].map(i => parseInt(selected.slice(i, i + 2), 16));
  function choose(color: string) { setSelected(color); setHex(color); }
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className="color-sheet" aria-labelledby={title} onCancel={onClose} onClose={onClose}>
    <header className="color-sheet-heading">
      <h2 id={title}>Colours</h2>
      <button type="button" aria-label="Cancel colour selection" onClick={onClose}><X size={24} /></button>
    </header>
    <div className="color-sheet-tabs" role="tablist" aria-label="Colour picker mode">
      {(["Grid", "Sliders"] as const).map(t => <button key={t} type="button" role="tab" aria-selected={tab === t}
        id={`${title}-${t}`} aria-controls={`${title}-panel`} tabIndex={tab === t ? 0 : -1}
        onClick={() => setTab(t)} onKeyDown={e => {
          if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
            e.preventDefault(); const next = t === "Grid" ? "Sliders" : "Grid"; setTab(next);
            document.getElementById(`${title}-${next}`)?.focus();
          }
        }}>{t}</button>)}
    </div>
    <div id={`${title}-panel`} role="tabpanel" aria-labelledby={`${title}-${tab}`}>
      {tab === "Grid" ? <div className="color-sheet-grid">
        {colorGrid().map(c => <button type="button" key={c} aria-label={`Colour ${c}`} aria-pressed={selected === c}
          style={{ background: c }} onClick={() => choose(c)} />)}
      </div> : <div className="color-sheet-sliders">
        {["Red", "Green", "Blue"].map((channel, i) => {
          const asHex = (n: number) => "#" + rgb.map((v, j) => (i === j ? n : v).toString(16).padStart(2, "0")).join("").toUpperCase();
          return <label key={channel}><span>{channel.toUpperCase()}</span><div>
            <input type="range" min={0} max={255} value={rgb[i]} aria-label={channel}
              style={{ background: `linear-gradient(to right, ${asHex(0)}, ${asHex(255)})` }}
              onChange={e => choose(asHex(Number(e.target.value)))} /><output>{rgb[i]}</output>
          </div></label>;
        })}
      </div>}
    </div>
    <label className="color-sheet-hex"><span>sRGB Hex Colour #</span>
      <input aria-label="Custom HEX colour" value={hex.replace(/^#/, "")} maxLength={7} spellCheck={false}
        autoComplete="off" autoCapitalize="characters" aria-invalid={!valid}
        onChange={e => { setHex(e.target.value); const c = normalizeHex(e.target.value); if (c) setSelected(c); }}
        onKeyDown={e => { if (e.key === "Enter" && valid) { e.preventDefault(); choose(valid); e.currentTarget.blur(); } }} />
    </label>
    {!valid && <p role="alert">Enter 3 or 6 HEX digits, e.g. FFAB01.</p>}
    <footer className="color-sheet-footer">
      <span className="color-sheet-preview" aria-label={`Selected colour ${selected}`} style={{ background: selected }} />
      <button type="button" className="subtle" onClick={onClose}>Cancel</button>
      <button type="button" className="primary" disabled={!valid} onClick={() => { if (valid) { onSave(valid); onClose(); } }}><Check size={18} /> Done</button>
    </footer>
  </dialog>;
}
