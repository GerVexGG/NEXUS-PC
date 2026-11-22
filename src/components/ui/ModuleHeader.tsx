import {
  Activity, Boxes, Cable, Clock3, FolderArchive, HardDrive, Layers3, PanelsTopLeft,
  RadioTower, Settings2, SquareTerminal,
} from "lucide-react";
import type { PageHeaderProps } from "../../lib/studio";
import "./ModuleSurfaces.css";

const symbols = {
  hardware: Activity, processes: Layers3, network: Cable, storage: HardDrive, startup: PanelsTopLeft,
  cleanup: Boxes, power: Clock3, scripts: SquareTerminal, settings: Settings2, drop: RadioTower,
  archive: FolderArchive,
};

export function ModuleHeader({ module, title, description, actions }: PageHeaderProps & { module: keyof typeof symbols }) {
  const Symbol = symbols[module];
  return (
    <header className="avs-module-head" data-module={module}>
      <div className="avs-module-heading">
        <span className="avs-module-symbol" aria-hidden="true"><Symbol size={25} strokeWidth={1.55} /></span>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {actions && <div className="avs-module-actions">{actions}</div>}
    </header>
  );
}
