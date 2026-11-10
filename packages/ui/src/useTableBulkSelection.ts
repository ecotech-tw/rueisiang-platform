import { useEffect, useMemo, useState } from "react";

export interface TableBulkAction<Row> {
  id: string;
  label: string;
  isEligible: (row: Row) => boolean;
}

export function useTableBulkSelection<Row>(rows: readonly Row[], getKey: (row: Row) => string, actions: readonly TableBulkAction<Row>[]) {
  const [active, setActive] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const action = actions.find((item) => item.id === actionId);
  const eligibleRows = useMemo(() => action ? rows.filter(action.isEligible) : [], [action, rows]);
  const eligibleKeys = useMemo(() => eligibleRows.map(getKey), [eligibleRows, getKey]);
  const eligibleKeySet = useMemo(() => new Set(eligibleKeys), [eligibleKeys]);
  const selectedKeySet = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const selectedRows = useMemo(() => eligibleRows.filter((row) => selectedKeySet.has(getKey(row))), [eligibleRows, getKey, selectedKeySet]);
  const allEligibleSelected = eligibleKeys.length > 0 && eligibleKeys.every((key) => selectedKeySet.has(key));
  const someEligibleSelected = eligibleKeys.some((key) => selectedKeySet.has(key));

  useEffect(() => {
    setSelectedKeys((current) => {
      const next = current.filter((key) => eligibleKeySet.has(key));
      return next.length === current.length ? current : next;
    });
  }, [eligibleKeySet]);

  function start() {
    setActive(true);
    setActionId(null);
    setSelectedKeys([]);
  }

  function chooseAction(nextActionId: string) {
    if (!actions.some((item) => item.id === nextActionId)) return;
    setActive(true);
    setActionId(nextActionId);
    setSelectedKeys([]);
  }

  function cancel() {
    setActive(false);
    setActionId(null);
    setSelectedKeys([]);
  }

  function toggleRow(row: Row, checked: boolean) {
    const key = getKey(row);
    if (!eligibleKeySet.has(key)) return;
    setSelectedKeys((current) => {
      if (checked) return current.includes(key) ? current : [...current, key];
      return current.filter((selectedKey) => selectedKey !== key);
    });
  }

  function toggleAll(checked: boolean) {
    setSelectedKeys((current) => checked
      ? [...new Set([...current, ...eligibleKeys])]
      : current.filter((key) => !eligibleKeySet.has(key)));
  }

  return {
    active,
    actionId,
    selectedKeys,
    eligibleRows,
    eligibleKeys,
    selectedRows,
    allEligibleSelected,
    someEligibleSelected,
    isRowEligible: (row: Row) => eligibleKeySet.has(getKey(row)),
    start,
    chooseAction,
    cancel,
    toggleRow,
    toggleAll,
  };
}
