import {
  DESIGN_LIMITS,
  DiagramNodeKind,
  type Diagram,
  type DiagramEdge,
  type DiagramNode,
} from '@cbi/shared-types';
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { BOX, clampToBoard, edgePoint, nextId, nextPosition } from './board';

const W = DESIGN_LIMITS.boardWidth;
const H = DESIGN_LIMITS.boardHeight;

const KIND_ICON: Record<DiagramNodeKind, string> = {
  client: '▭',
  service: '⚙',
  database: '⛁',
  cache: '⚡',
  queue: '≡',
  storage: '▤',
  external: '☁',
  other: '◇',
};

/**
 * A small boxes-and-arrows whiteboard (SVG; nothing loaded from elsewhere).
 * Boxes are added with a name and a kind, moved by dragging or with the
 * arrow keys, and joined by labelled arrows. Everything on the board is
 * also listed as text with its own controls, for keyboard and screen
 * reader users.
 */
export function Whiteboard({
  diagram,
  onChange,
  readOnly,
}: {
  diagram: Diagram;
  onChange: (next: Diagram) => void;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<DiagramNodeKind>('service');
  const [to, setTo] = useState('');
  const [arrowLabel, setArrowLabel] = useState('');
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const current = selected ? (byId.get(selected) ?? null) : null;
  const full = diagram.nodes.length >= DESIGN_LIMITS.maxNodes;

  const setNodes = (nodes: DiagramNode[], edges: DiagramEdge[] = diagram.edges) =>
    onChange({ nodes, edges });
  const move = (nodeId: string, x: number, y: number) =>
    setNodes(diagram.nodes.map((n) => (n.id === nodeId ? { ...n, ...clampToBoard(x, y) } : n)));

  function addBox() {
    const name = label.trim().slice(0, DESIGN_LIMITS.maxLabelChars);
    if (!name || full) return;
    const node: DiagramNode = {
      id: nextId('n', diagram.nodes),
      label: name,
      kind,
      ...nextPosition(diagram.nodes.length),
    };
    setNodes([...diagram.nodes, node]);
    setSelected(node.id);
    setLabel('');
  }

  function removeBox(nodeId: string) {
    setNodes(
      diagram.nodes.filter((n) => n.id !== nodeId),
      diagram.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
    );
    if (selected === nodeId) setSelected(null);
  }

  function connect() {
    if (!current || !to || to === current.id) return;
    if (diagram.edges.length >= DESIGN_LIMITS.maxEdges) return;
    const edge: DiagramEdge = {
      id: nextId('e', diagram.edges),
      from: current.id,
      to,
      label: arrowLabel.trim().slice(0, DESIGN_LIMITS.maxLabelChars),
    };
    onChange({ nodes: diagram.nodes, edges: [...diagram.edges, edge] });
    setTo('');
    setArrowLabel('');
  }

  /** Board coordinates of a pointer event (unscaled when the browser cannot tell). */
  function boardPoint(e: PointerEvent) {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM?.();
    if (!svg || !ctm) return { x: e.clientX, y: e.clientY };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  function onBoxKey(e: KeyboardEvent, node: DiagramNode) {
    const step = e.shiftKey ? 50 : 10;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = moves[e.key];
    if (d && !readOnly) {
      e.preventDefault();
      move(node.id, node.x + d[0], node.y + d[1]);
    } else if (e.key === 'Delete' && !readOnly) {
      e.preventDefault();
      removeBox(node.id);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setSelected(node.id);
    }
  }

  return (
    <div className="d-flex flex-column gap-2">
      {!readOnly && (
        <div className="d-flex flex-wrap align-items-end gap-2">
          <div>
            <label htmlFor={`${id}-label`} className="form-label small mb-0">
              {t('design.board.boxName')}
            </label>
            <input
              id={`${id}-label`}
              className="form-control form-control-sm"
              maxLength={DESIGN_LIMITS.maxLabelChars}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addBox();
                }
              }}
            />
          </div>
          <div>
            <label htmlFor={`${id}-kind`} className="form-label small mb-0">
              {t('design.board.kind')}
            </label>
            <select
              id={`${id}-kind`}
              className="form-select form-select-sm"
              value={kind}
              onChange={(e) => setKind(e.target.value as DiagramNodeKind)}
            >
              {DiagramNodeKind.options.map((k) => (
                <option key={k} value={k}>
                  {t(`design.kinds.${k}`)}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-outline-primary"
            disabled={!label.trim() || full}
            onClick={addBox}
          >
            <i className="bi bi-plus-square me-1" aria-hidden="true" />
            {t('design.board.addBox')}
          </button>
          {full && (
            <span className="small cb-text-secondary">
              {t('design.board.full', { max: DESIGN_LIMITS.maxNodes })}
            </span>
          )}
        </div>
      )}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-100 border cb-border rounded-2"
        style={{ touchAction: 'none', maxHeight: '28rem' }}
        role="group"
        aria-label={t('design.board.region')}
        aria-describedby={`${id}-help`}
        onPointerMove={(e) => {
          if (!drag.current || readOnly) return;
          const p = boardPoint(e);
          move(drag.current.id, p.x - drag.current.dx, p.y - drag.current.dy);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerLeave={() => {
          drag.current = null;
        }}
      >
        <defs>
          <marker
            id={`${id}-arrow`}
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--cb-text-secondary)" />
          </marker>
        </defs>
        <rect x="0" y="0" width={W} height={H} fill="var(--cb-background)" />
        {diagram.edges.map((e) => {
          const a = byId.get(e.from);
          const b = byId.get(e.to);
          if (!a || !b) return null;
          const p1 = edgePoint(a, b);
          const p2 = edgePoint(b, a);
          return (
            <g key={e.id} aria-hidden="true">
              <line
                x1={p1.x}
                y1={p1.y}
                x2={p2.x}
                y2={p2.y}
                stroke="var(--cb-text-secondary)"
                strokeWidth="2"
                markerEnd={`url(#${id}-arrow)`}
              />
              {e.label && (
                <text
                  x={(p1.x + p2.x) / 2}
                  y={(p1.y + p2.y) / 2 - 6}
                  textAnchor="middle"
                  fontSize="14"
                  fill="var(--cb-text-secondary)"
                >
                  {e.label}
                </text>
              )}
            </g>
          );
        })}
        {diagram.nodes.map((n) => (
          <g
            key={n.id}
            role="button"
            tabIndex={0}
            aria-label={t('design.board.boxLabel', {
              label: n.label,
              kind: t(`design.kinds.${n.kind}`),
            })}
            aria-pressed={selected === n.id}
            transform={`translate(${n.x} ${n.y})`}
            style={{ cursor: readOnly ? 'default' : 'move' }}
            onFocus={() => setSelected(n.id)}
            onKeyDown={(e) => onBoxKey(e, n)}
            onPointerDown={(e) => {
              setSelected(n.id);
              if (readOnly) return;
              const p = boardPoint(e);
              drag.current = { id: n.id, dx: p.x - n.x, dy: p.y - n.y };
              e.currentTarget.ownerSVGElement?.setPointerCapture?.(e.pointerId);
            }}
          >
            <rect
              width={BOX.w}
              height={BOX.h}
              rx="8"
              fill="var(--cb-surface-muted)"
              stroke={selected === n.id ? 'var(--cb-primary)' : 'var(--cb-border)'}
              strokeWidth={selected === n.id ? 3 : 1.5}
            />
            <text x="10" y="22" fontSize="13" fill="var(--cb-text-secondary)">
              {KIND_ICON[n.kind]} {t(`design.kinds.${n.kind}`)}
            </text>
            <text x="10" y="44" fontSize="15" fontWeight="600" fill="var(--cb-text-primary)">
              {n.label.length > 18 ? `${n.label.slice(0, 17)}…` : n.label}
            </text>
          </g>
        ))}
      </svg>
      <p id={`${id}-help`} className="small cb-text-secondary mb-0">
        {readOnly ? t('design.board.helpReadOnly') : t('design.board.help')}
      </p>

      {current && !readOnly && (
        <fieldset className="border cb-border rounded-2 p-2">
          <legend className="small fw-semibold float-none w-auto px-1 mb-0">
            {t('design.board.selected', { label: current.label })}
          </legend>
          <div className="d-flex flex-wrap align-items-end gap-2">
            <div>
              <label htmlFor={`${id}-rename`} className="form-label small mb-0">
                {t('design.board.rename')}
              </label>
              <input
                id={`${id}-rename`}
                className="form-control form-control-sm"
                maxLength={DESIGN_LIMITS.maxLabelChars}
                value={current.label}
                onChange={(e) =>
                  e.target.value.trim() &&
                  setNodes(
                    diagram.nodes.map((n) =>
                      n.id === current.id ? { ...n, label: e.target.value } : n,
                    ),
                  )
                }
              />
            </div>
            <div>
              <label htmlFor={`${id}-to`} className="form-label small mb-0">
                {t('design.board.connectTo')}
              </label>
              <select
                id={`${id}-to`}
                className="form-select form-select-sm"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              >
                <option value="">{t('design.board.chooseBox')}</option>
                {diagram.nodes
                  .filter((n) => n.id !== current.id)
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${id}-arrow-label`} className="form-label small mb-0">
                {t('design.board.arrowLabel')}
              </label>
              <input
                id={`${id}-arrow-label`}
                className="form-control form-control-sm"
                maxLength={DESIGN_LIMITS.maxLabelChars}
                value={arrowLabel}
                onChange={(e) => setArrowLabel(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={!to}
              onClick={connect}
            >
              <i className="bi bi-arrow-right me-1" aria-hidden="true" />
              {t('design.board.connect')}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              onClick={() => removeBox(current.id)}
            >
              <i className="bi bi-trash me-1" aria-hidden="true" />
              {t('design.board.removeBox')}
            </button>
          </div>
        </fieldset>
      )}

      <details>
        <summary className="small">
          {t('design.board.listTitle', {
            boxes: diagram.nodes.length,
            arrows: diagram.edges.length,
          })}
        </summary>
        <ul className="small mb-0 mt-2">
          {diagram.edges.map((e) => (
            <li key={e.id} className="d-flex flex-wrap align-items-center gap-2 mb-1">
              <span>
                {byId.get(e.from)?.label} → {byId.get(e.to)?.label}
                {e.label ? `: ${e.label}` : ''}
              </span>
              {!readOnly && (
                <button
                  type="button"
                  className="btn btn-link btn-sm p-0"
                  onClick={() =>
                    onChange({
                      nodes: diagram.nodes,
                      edges: diagram.edges.filter((x) => x.id !== e.id),
                    })
                  }
                >
                  {t('design.board.removeArrow', {
                    from: byId.get(e.from)?.label ?? '',
                    to: byId.get(e.to)?.label ?? '',
                  })}
                </button>
              )}
            </li>
          ))}
          {diagram.edges.length === 0 && <li>{t('design.board.noArrows')}</li>}
        </ul>
      </details>
    </div>
  );
}
