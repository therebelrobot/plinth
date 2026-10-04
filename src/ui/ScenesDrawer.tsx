import { useEffect, useState } from 'react';
import { sceneApi, type SceneSummary } from '../lib/api';
import { Icon } from './Icon';

export function ScenesDrawer(props: {
  currentId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDuplicate: () => void;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [scenes, setScenes] = useState<SceneSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    sceneApi.list().then(setScenes).catch(() => setError('The server is unreachable — scenes are being kept on this device until it is back.'));
  };
  useEffect(refresh, []);

  const remove = async (scene: SceneSummary) => {
    if (!window.confirm(`Delete “${scene.name}”? This can't be undone.`)) return;
    try {
      await sceneApi.remove(scene.id);
      props.notify(`Deleted ${scene.name}`);
      if (scene.id === props.currentId) props.onNew();
      refresh();
    } catch {
      props.notify('Delete failed');
    }
  };

  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div className="sheet" role="dialog" aria-label="Scenes" onClick={(event) => event.stopPropagation()}>
        <header className="sheet-header">
          <h2>Scenes</h2>
          <button type="button" className="icon-button" onClick={props.onClose} aria-label="Close"><Icon name="close" /></button>
        </header>
        <div className="button-row">
          <button type="button" className="button primary" onClick={props.onNew}><Icon name="plus" size={16} /> New scene</button>
          <button type="button" className="button" onClick={props.onDuplicate}><Icon name="copy" size={16} /> Duplicate current</button>
        </div>
        {error && <p className="muted">{error}</p>}
        {!scenes && !error && <p className="muted">Loading…</p>}
        <ul className="scene-list">
          {scenes?.map((scene) => (
            <li key={scene.id} className={scene.id === props.currentId ? 'is-current' : ''}>
              <button type="button" className="scene-open" onClick={() => props.onOpen(scene.id)}>
                <strong>{scene.name}</strong>
                <small>{new Date(scene.updatedAt).toLocaleString()}</small>
              </button>
              <button type="button" className="icon-button" aria-label={`Delete ${scene.name}`} onClick={() => remove(scene)}><Icon name="trash" size={18} /></button>
            </li>
          ))}
          {scenes?.length === 0 && <li className="muted">No saved scenes yet.</li>}
        </ul>
      </div>
    </div>
  );
}
