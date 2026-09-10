import type { ReactNode } from "react";

export interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

 
export function Panel({ title, description, actions, className = "", children }: PanelProps) {
  const hasHeader = title || description || actions;

  return (
    <section className={`panel ${className}`.trim()}>
      {hasHeader ? (
        <div className="panel-head">
          <div>
            {title ? <h2 className="panel-title">{title}</h2> : null}
            {description ? <p className="muted">{description}</p> : null}
          </div>
          {actions ? <div>{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

 
export function PageHeader({ title, description, actions, className = "" }: PageHeaderProps) {
  return (
    <header className={`page-head${actions ? " page-head-row" : ""} ${className}`.trim()}>
      <div>
        <h1>{title}</h1>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      {actions ? <div>{actions}</div> : null}
    </header>
  );
}
