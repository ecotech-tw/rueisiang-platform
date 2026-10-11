import { useEffect, useRef, useState } from "react";
import type { Profile } from "./api.js";

export function employeeSections(profile: Profile) {
  const formalEmployee = profile.employee.personKind !== "worker" && profile.employee.userId !== null;
  return [
    ...(formalEmployee ? [{ id: "employee-photo", label: "大頭貼" }] : []),
    { id: "employee-basic", label: "基本資料" },
    ...(formalEmployee ? [{ id: "employee-contact", label: "聯絡資料" }, { id: "employee-company", label: "公司／任職" }] : []),
    { id: "employee-compensation", label: "敘薪" },
    ...(formalEmployee ? [{ id: "employee-insurance", label: "保險" }, { id: "employee-attendance", label: "出勤" }] : []),
    ...(profile.employments.length > 1 ? [{ id: "employee-history", label: "任職歷史" }] : []),
  ];
}

export function EmployeeSectionNav({ profile }: { profile: Profile }) {
  const nav = useRef<HTMLElement>(null);
  const sections = employeeSections(profile);
  const sectionIds = sections.map(({ id }) => id).join(",");
  const [active, setActive] = useState(sections[0]?.id ?? "");
  useEffect(() => {
    const root = nav.current?.closest(".hr-system-main");
    const update = () => {
      const top = (nav.current?.getBoundingClientRect().bottom ?? root?.getBoundingClientRect().top ?? 0) + 24;
      const passed = sections.filter(({ id }) => { const block = document.getElementById(id); return block && block.getBoundingClientRect().top <= top; });
      const bottom = root && root.scrollHeight > root.clientHeight && root.scrollHeight - root.scrollTop - root.clientHeight <= 2;
      setActive((bottom ? sections.at(-1)?.id : passed.at(-1)?.id) ?? sections[0]?.id ?? "");
    };
    update();
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { document.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [sectionIds]);
  return <nav ref={nav} className="hr-employee-section-nav" aria-label="員工檔案區塊導覽">
    {sections.map(({ id, label }) => <a key={id} href={`#${id}`} aria-current={active === id ? "location" : undefined} onClick={(event) => {
      const target = document.getElementById(id);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ block: "start", behavior: "instant" });
      const heading = target.querySelector("h2");
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
      setActive(id);
    }}>{label}</a>)}
  </nav>;
}
