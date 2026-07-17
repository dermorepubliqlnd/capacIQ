import { useState } from "react";
import { GripVertical } from "lucide-react";
import { TONE_STYLES } from "../lib/tableTypes";

export interface BoardColumnDef {
  value: string;
  label: string;
  // Groups several adjacent columns under one small section label (e.g.
  // Projects' 11 exact statuses cluster under To-do / In Progress /
  // Complete) so a wide board still reads with some structure. Columns
  // that share the same clusterLabel are expected to be adjacent in the
  // `columns` array -- the header is only drawn once, above the first
  // column of each run.
  clusterLabel?: string;
  tone?: string;
}

interface BoardViewProps<T> {
  rows: T[];
  rowKey: (row: T) => string;
  columns: BoardColumnDef[];
  getValue: (row: T) => string | null;
  hiddenColumns: string[];
  renderCard: (row: T) => React.ReactNode;
  // When provided, cards can be dragged between columns (writes the new
  // status-like value back) and reordered within a column (writes
  // sort_order). When omitted, the board still groups rows into columns
  // but renders them as a static, non-draggable read-only layout -- used
  // when the active grouping isn't one CapacIQ knows how to write back
  // (e.g. grouped by Owner or Category instead of Status).
  onMoveCard?: (row: T, newValue: string) => void;
  onReorderCard?: (draggedKey: string, targetKey: string) => void;
}

const NO_VALUE_COLUMN = "__none__";

export default function BoardView<T>({
  rows,
  rowKey,
  columns,
  getValue,
  hiddenColumns,
  renderCard,
  onMoveCard,
  onReorderCard,
}: BoardViewProps<T>) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const draggable = Boolean(onMoveCard && onReorderCard);

  const hasUnassigned = rows.some((r) => !getValue(r));
  const allColumns: BoardColumnDef[] = hasUnassigned
    ? [{ value: NO_VALUE_COLUMN, label: "No status" }, ...columns]
    : columns;
  const visibleColumns = allColumns.filter((c) => !hiddenColumns.includes(c.value));

  function rowsFor(columnValue: string) {
    return rows.filter((r) => (getValue(r) ?? NO_VALUE_COLUMN) === columnValue);
  }

  function handleDropOnCard(e: React.DragEvent, targetRow: T, columnValue: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!dragKey || !onMoveCard || !onReorderCard) return;
    const draggedRow = rows.find((r) => rowKey(r) === dragKey);
    if (!draggedRow || dragKey === rowKey(targetRow)) return;
    const draggedValue = getValue(draggedRow) ?? NO_VALUE_COLUMN;
    if (draggedValue !== columnValue) {
      onMoveCard(draggedRow, columnValue === NO_VALUE_COLUMN ? "" : columnValue);
    }
    onReorderCard(dragKey, rowKey(targetRow));
    setDragKey(null);
  }

  function handleDropOnColumn(e: React.DragEvent, columnValue: string) {
    e.preventDefault();
    if (!dragKey || !onMoveCard) return;
    const draggedRow = rows.find((r) => rowKey(r) === dragKey);
    if (!draggedRow) return;
    const draggedValue = getValue(draggedRow) ?? NO_VALUE_COLUMN;
    if (draggedValue !== columnValue) {
      onMoveCard(draggedRow, columnValue === NO_VALUE_COLUMN ? "" : columnValue);
    }
    setDragKey(null);
  }

  return (
    <div className="board-view">
      {visibleColumns.map((col, idx) => {
        const isClusterStart = col.clusterLabel && col.clusterLabel !== visibleColumns[idx - 1]?.clusterLabel;
        const colRows = rowsFor(col.value);
        const tone = TONE_STYLES[col.tone ?? "neutral"] ?? TONE_STYLES.neutral;
        return (
          <div key={col.value} className="board-column" style={{ background: tone.bg }}>
            <div className="board-column-cluster" style={{ color: tone.text }}>{isClusterStart ? col.clusterLabel : " "}</div>
            <div className="board-column-header" style={{ color: tone.text }}>
              {col.label}
              <span className="board-column-count">{colRows.length}</span>
            </div>
            <div
              className="board-column-body"
              onDragOver={draggable ? (e) => e.preventDefault() : undefined}
              onDrop={draggable ? (e) => handleDropOnColumn(e, col.value) : undefined}
            >
              {colRows.map((row) => {
                const key = rowKey(row);
                return (
                  <div
                    key={key}
                    className="board-card"
                    draggable={draggable}
                    onDragStart={draggable ? () => setDragKey(key) : undefined}
                    onDragEnd={draggable ? () => setDragKey(null) : undefined}
                    onDragOver={draggable ? (e) => e.preventDefault() : undefined}
                    onDrop={draggable ? (e) => handleDropOnCard(e, row, col.value) : undefined}
                    style={{ opacity: dragKey === key ? 0.4 : 1 }}
                  >
                    {draggable && (
                      <span className="board-card-grip">
                        <GripVertical size={12} />
                      </span>
                    )}
                    <div className="board-card-body">{renderCard(row)}</div>
                  </div>
                );
              })}
              {colRows.length === 0 && <div className="board-column-empty">No items</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
