import { FlashState } from './useFloor';

export function Flash({ flash }: { flash: FlashState }) {
  return (
    <div className={`flash flash-${flash.tone}`} role="status" data-tone={flash.tone}>
      <span className="flash-title">{flash.title}</span>
      {flash.detail && <span className="flash-detail mono">{flash.detail}</span>}
      {flash.sub && <span className="flash-sub">{flash.sub}</span>}
    </div>
  );
}
