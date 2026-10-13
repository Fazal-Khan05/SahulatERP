'use client';
import { Check, Link2 } from 'lucide-react';
import { moduleCatalogue, moduleRecordCounts, presets, withRequirements, dependentsOf } from '@/modules/erp/modules';
import type { ToggleModule, Workspace } from '@/modules/erp/types';

/**
 * Module cards with toggles, shared by the setup wizard and Settings → Features.
 * Dependencies are resolved here for display; the server resolves them again when saving.
 */
export function ModulePicker({ selected, onChange, workspace, disabled = false, showPresets = true }: {
  selected: ToggleModule[];
  onChange: (next: ToggleModule[]) => void;
  workspace?: Workspace;
  disabled?: boolean;
  showPresets?: boolean;
}) {
  const on = new Set(selected);
  const labelOf = (key: ToggleModule) => moduleCatalogue.find(item => item.key === key)!.label;
  function toggle(key: ToggleModule) {
    if (on.has(key)) {
      const off = new Set([key, ...dependentsOf(key, selected)]);
      onChange(selected.filter(item => !off.has(item)));
    } else onChange(withRequirements([...selected, key]));
  }
  return <div className="module-picker">
    {showPresets && <div className="module-presets" role="group" aria-label="Presets">
      {presets.map(preset => {
        const active = preset.modules.length === selected.length && preset.modules.every(key => on.has(key));
        return <button key={preset.key} type="button" className={`module-preset ${active ? 'active' : ''}`} disabled={disabled} onClick={() => onChange(withRequirements(preset.modules))}>
          <strong>{preset.label}</strong><small>{preset.description}</small>
        </button>;
      })}
    </div>}
    <div className="module-grid">
      {moduleCatalogue.map(item => {
        const enabled = on.has(item.key);
        const missing = item.requires.filter(dep => !on.has(dep));
        const dependents = enabled ? dependentsOf(item.key, selected) : [];
        const counts = workspace && enabled ? moduleRecordCounts(workspace, item.key).filter(c => c.count > 0) : [];
        return <label key={item.key} className={`module-card ${enabled ? 'enabled' : ''}`}>
          <div className="module-card-head">
            <span className="module-card-title">{item.label}</span>
            <span className="switch">
              <input type="checkbox" role="switch" aria-label={`${item.label} module`} checked={enabled} disabled={disabled} onChange={() => toggle(item.key)}/>
              <span className="switch-track"><span className="switch-thumb">{enabled && <Check size={11}/>}</span></span>
            </span>
          </div>
          <p>{item.description}</p>
          <small className="module-card-setup">{enabled ? 'Sets up: ' : 'Will set up: '}{item.setsUp}</small>
          {item.requires.length > 0 && <small className="module-card-dep"><Link2 size={12}/>{enabled || !missing.length ? `Uses ${item.requires.map(labelOf).join(' and ')}` : `Turning this on also turns on ${missing.map(labelOf).join(' and ')}`}</small>}
          {dependents.length > 0 && <small className="module-card-dep warn">Turning this off also turns off {dependents.map(labelOf).join(', ')}</small>}
          {counts.length > 0 && <small className="module-card-counts">{counts.map(c => `${c.count} ${c.label}`).join(' · ')}</small>}
        </label>;
      })}
    </div>
  </div>;
}
