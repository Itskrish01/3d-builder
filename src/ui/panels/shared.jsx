import { useEngine, useEngineTopic } from '../EngineProvider.jsx';
import { ToolRow } from '../controls.jsx';
import { toolCopy } from '../copy.jsx';

/** The tools a station shows up front. */
export function StationTools({ station }) {
  const engine = useEngine();
  useEngineTopic('mode');
  const tools = engine.MODE_TOOLS[station].map((id) => ({ id, ...toolCopy(station, id) }));
  return <ToolRow tools={tools} current={engine.currentTool()} onPick={engine.setTool} />;
}

/** The ones behind "All settings" — same row, one panel deeper. */
export function ExtraTools({ station }) {
  const engine = useEngine();
  useEngineTopic('mode');
  const ids = engine.EXTRA_TOOLS[station] || [];
  if (!ids.length) return null;
  const tools = ids.map((id) => ({ id, ...toolCopy(station, id) }));
  return <ToolRow tools={tools} current={engine.currentTool()} onPick={engine.setTool} />;
}
