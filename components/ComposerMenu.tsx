'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuOption {
  id: string;
  label: string;
  detail?: string | null;
}

export interface ComposerMenuProps {
  onAddFiles: () => void;
  onScreenshot: () => void;

  projects: { id: string; name: string }[];
  projectId: string | null;
  onSetProject: (id: string | null) => void;

  connectors: MenuOption[];
  activeConnectors: string[];
  onToggleConnector: (id: string) => void;
  /** Shows the warning line when documents and an outside system are both in play. */
  hasDocuments: boolean;

  skills: MenuOption[];
  pinnedSkills: string[];
  onToggleSkill: (id: string) => void;

  styles: MenuOption[];
  styleId: string;
  onSetStyle: (id: string) => void;

  memoryEnabled: boolean;
  onToggleMemory: () => void;

  onOpenSettings: () => void;
}

/* ------------------------------------------------------------- primitives */

function Row({
  icon,
  label,
  hint,
  checked,
  submenu,
  onClick,
  onHover,
  active,
}: {
  icon: string;
  label: string;
  hint?: string;
  checked?: boolean;
  submenu?: boolean;
  onClick?: () => void;
  onHover?: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      onMouseEnter={onHover}
      className={`flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[13.5px] ${
        active ? 'bg-raised text-ink' : 'text-ink-dim hover:bg-raised hover:text-ink'
      }`}
    >
      <span className="w-4 shrink-0 text-center text-[13px] opacity-80">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {hint ? <span className="shrink-0 text-[11.5px] text-ink-faint">{hint}</span> : null}
      {checked ? <span className="shrink-0 text-accent">✓</span> : null}
      {submenu ? <span className="shrink-0 text-ink-faint">›</span> : null}
    </button>
  );
}

function Submenu({ children }: { children: ReactNode }) {
  return (
    <div className="absolute bottom-0 left-full z-30 ml-1 max-h-[340px] w-64 overflow-y-auto rounded-xl border border-line bg-panel py-1 shadow-xl">
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ menu */

type Section = 'project' | 'skills' | 'connectors' | 'styles' | null;

/**
 * One menu behind the composer's `＋`, rather than a row of buttons.
 *
 * The row worked while there were three controls and stopped working at seven:
 * everything that is occasionally useful was permanently on screen, competing
 * with the thing people are actually doing, which is typing. What stays outside
 * is what changes an answer every time — the model and how hard it thinks.
 */
export function ComposerMenu(props: ComposerMenuProps) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<Section>(null);
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const away = (e: MouseEvent) => {
      if (!holder.current?.contains(e.target as Node)) {
        setOpen(false);
        setSection(null);
      }
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Back out of a submenu first, the way a nested menu should behave.
      if (section) setSection(null);
      else setOpen(false);
    };

    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', escape);
    };
  }, [open, section]);

  const close = () => {
    setOpen(false);
    setSection(null);
  };

  const activeCount = props.activeConnectors.length;
  const currentProject = props.projects.find((p) => p.id === props.projectId);
  const currentStyle = props.styles.find((s) => s.id === props.styleId);

  return (
    <div ref={holder} className="relative">
      <button
        onClick={() => (open ? close() : setOpen(true))}
        title="Attach, connect and configure"
        className={`grid h-7.5 w-7.5 place-items-center rounded-lg border text-[16px] leading-none ${
          open ? 'border-accent bg-raised text-ink' : 'border-line text-ink-dim hover:bg-raised hover:text-ink'
        }`}
      >
        ＋
      </button>

      {open ? (
        <div className="absolute bottom-full left-0 z-20 mb-1.5 w-64 rounded-xl border border-line bg-panel py-1 shadow-xl">
          <Row
            icon="🖇"
            label="Add files or photos"
            hint="⌘U"
            onClick={() => {
              close();
              props.onAddFiles();
            }}
          />
          <Row
            icon="⛶"
            label="Take a screenshot"
            onClick={() => {
              close();
              props.onScreenshot();
            }}
          />

          <div className="my-1 border-t border-line-soft" />

          {/* ------------------------------------------------- project */}
          <div className="relative" onMouseLeave={() => setSection(null)}>
            <Row
              icon="▤"
              label="Add to project"
              hint={currentProject?.name}
              submenu
              active={section === 'project'}
              onHover={() => setSection('project')}
              onClick={() => setSection(section === 'project' ? null : 'project')}
            />
            {section === 'project' ? (
              <Submenu>
                <Row
                  icon={props.projectId ? ' ' : '✓'}
                  label="No project"
                  onClick={() => {
                    props.onSetProject(null);
                    close();
                  }}
                />
                {props.projects.map((p) => (
                  <Row
                    key={p.id}
                    icon={p.id === props.projectId ? '✓' : ' '}
                    label={p.name}
                    onClick={() => {
                      props.onSetProject(p.id);
                      close();
                    }}
                  />
                ))}
                {props.projects.length === 0 ? (
                  <div className="px-3 py-2 text-[12.5px] text-ink-faint">
                    No projects yet — make one in the sidebar.
                  </div>
                ) : null}
              </Submenu>
            ) : null}
          </div>

          {/* --------------------------------------------------- skills */}
          <div className="relative" onMouseLeave={() => setSection(null)}>
            <Row
              icon="◫"
              label="Skills"
              hint={props.pinnedSkills.length ? String(props.pinnedSkills.length) : undefined}
              submenu
              active={section === 'skills'}
              onHover={() => setSection('skills')}
              onClick={() => setSection(section === 'skills' ? null : 'skills')}
            />
            {section === 'skills' ? (
              <Submenu>
                <div className="px-3 pt-1 pb-2 text-[11.5px] text-ink-faint">
                  Skills fire on their own when they match. Tick one to make it apply
                  to this chat whatever is asked.
                </div>
                {props.skills.map((s) => (
                  <Row
                    key={s.id}
                    icon={props.pinnedSkills.includes(s.id) ? '✓' : ' '}
                    label={s.label}
                    hint={s.detail ?? undefined}
                    onClick={() => props.onToggleSkill(s.id)}
                  />
                ))}
                {props.skills.length === 0 ? (
                  <div className="px-3 py-2 text-[12.5px] text-ink-faint">
                    None installed. Add one under Settings, or ask an admin for a
                    firm-wide one.
                  </div>
                ) : null}
              </Submenu>
            ) : null}
          </div>

          {/* ---------------------------------------------- connectors */}
          <div className="relative" onMouseLeave={() => setSection(null)}>
            <Row
              icon="⚯"
              label="Connectors"
              hint={activeCount ? String(activeCount) : undefined}
              submenu
              active={section === 'connectors'}
              onHover={() => setSection('connectors')}
              onClick={() => setSection(section === 'connectors' ? null : 'connectors')}
            />
            {section === 'connectors' ? (
              <Submenu>
                {props.connectors.map((c) => (
                  <Row
                    key={c.id}
                    icon={props.activeConnectors.includes(c.id) ? '✓' : ' '}
                    label={c.label}
                    hint={c.detail ?? undefined}
                    onClick={() => props.onToggleConnector(c.id)}
                  />
                ))}
                {props.connectors.length === 0 ? (
                  <div className="px-3 py-2 text-[12.5px] text-ink-faint">
                    Nothing connected. Add an account under Settings, or ask an admin
                    for a connector.
                  </div>
                ) : null}
                {props.hasDocuments && activeCount ? (
                  <div className="mt-1 border-t border-line-soft bg-sev-math/10 px-3 py-2 text-[11.5px] text-[#dcc79a]">
                    Documents are in this chat and it can reach an outside system.
                    Nothing is sent out unless you ask, and every call is logged.
                  </div>
                ) : null}
              </Submenu>
            ) : null}
          </div>

          {/* --------------------------------------------------- style */}
          <div className="relative" onMouseLeave={() => setSection(null)}>
            <Row
              icon="✎"
              label="Style"
              hint={currentStyle?.label}
              submenu
              active={section === 'styles'}
              onHover={() => setSection('styles')}
              onClick={() => setSection(section === 'styles' ? null : 'styles')}
            />
            {section === 'styles' ? (
              <Submenu>
                {props.styles.map((s) => (
                  <Row
                    key={s.id}
                    icon={s.id === props.styleId ? '✓' : ' '}
                    label={s.label}
                    onClick={() => {
                      props.onSetStyle(s.id);
                      close();
                    }}
                  />
                ))}
              </Submenu>
            ) : null}
          </div>

          <div className="my-1 border-t border-line-soft" />

          <Row
            icon="◔"
            label="Memory"
            checked={props.memoryEnabled}
            onClick={props.onToggleMemory}
          />
          <Row
            icon="⚙"
            label="Settings"
            onClick={() => {
              close();
              props.onOpenSettings();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
