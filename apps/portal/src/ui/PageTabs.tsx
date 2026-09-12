import { NavLink } from "react-router";
import { Icon, type IconName } from "../shell/icons.js";

export interface PageTab {
  label: string;
  to: string;
  icon?: IconName;
}

/**
 * 同一個功能底下平行子頁面的切換列。做成分段控制：一條內凹的底槽，選中的那一段
 * 浮起來變成一張白卡。
 *
 * **不在這裡讀權限。** 呼叫端自己先濾好再傳進來：哪個分頁要哪個權限是那一區的
 * 知識，塞進共用元件會讓它得認識每一個功能的權限鍵。
 *
 * 只剩一個分頁時照樣畫得出來——那一段仍然在說「你在這裡」，而且分頁數量會隨權限
 * 變動，為了少一段而讓版面忽有忽無反而更難讀。
 */
export function PageTabs({ tabs, label }: { tabs: PageTab[]; label: string }) {
  if (!tabs.length) return null;
  return (
    <nav className="page-tabs" aria-label={label}>
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end
          className={({ isActive }) => `page-tab${isActive ? " active" : ""}`}
        >
          {tab.icon ? <Icon name={tab.icon} /> : null}
          <span>{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
