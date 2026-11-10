import { Menu } from "@base-ui/react/menu";
import { Button } from "./Button.js";
import { Icon } from "./icons.js";

export interface TableBulkActionOption {
  id: string;
  label: string;
  eligibleCount: number;
}

interface TableBulkActionMenuProps {
  actionId: string | null;
  actions: readonly TableBulkActionOption[];
  disabled?: boolean;
  onChange: (actionId: string | null) => void;
}

export function TableBulkActionMenu({ actionId, actions, disabled = false, onChange }: TableBulkActionMenuProps) {
  if (actionId) {
    return <Button variant="secondary" active icon="close" disabled={disabled} onClick={() => onChange(null)}>取消批次操作</Button>;
  }

  if (actions.length === 1) {
    const action = actions[0];
    if (action) return <Button variant="secondary" icon="list" disabled={disabled || action.eligibleCount === 0} onClick={() => onChange(action.id)}>批次操作</Button>;
  }

  return <Menu.Root>
    <Menu.Trigger render={<Button variant="secondary" icon="list" disabled={disabled || !actions.some((action) => action.eligibleCount > 0)}>批次操作</Button>} />
    <Menu.Portal>
      <Menu.Positioner side="bottom" align="end" sideOffset={6}>
        <Menu.Popup className="min-w-[220px] rounded-xl border border-line bg-paper p-1.5 [box-shadow:var(--shadow-panel)]">
          {actions.map((action) => <Menu.Item
            key={action.id}
            disabled={action.eligibleCount === 0}
            className="flex min-h-10 items-center justify-between gap-4 rounded-lg px-3 py-2 text-[13px] font-semibold text-ink outline-none data-[highlighted]:bg-brand-soft data-[highlighted]:text-brand-dark data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45"
            onClick={() => onChange(action.id)}
          >
            <span>{action.label}</span>
            <span className="text-[12px] tabular-nums text-muted">{action.eligibleCount}</span>
            {action.id === actionId ? <Icon name="check" className="size-4 text-brand" /> : null}
          </Menu.Item>)}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>;
}
