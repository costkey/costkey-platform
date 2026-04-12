import { useState, useCallback } from "react";
import { Treemap, ResponsiveContainer, Tooltip } from "recharts";
import { ChevronLeft } from "lucide-react";
import { formatCost, truncateFile } from "../utils";
import type { InsightsData } from "../api";

interface Props {
  data: InsightsData;
  projectId: string;
}

interface TreeNode {
  name: string;
  fullPath?: string;
  size: number;
  cost: number;
  calls: number;
  children?: TreeNode[];
}

const COLORS = [
  "#34d399", "#22d3ee", "#fbbf24", "#a78bfa", "#fb7185",
  "#60a5fa", "#f97316", "#14b8a6", "#e879f9", "#84cc16",
  "#f43f5e", "#0ea5e9", "#eab308", "#8b5cf6", "#ec4899",
];

function buildTree(data: InsightsData): TreeNode {
  // Build: root → modules → functions (from hotspots)
  const moduleMap = new Map<string, TreeNode>();

  // Start with modules
  for (const mod of data.modules) {
    moduleMap.set(mod.module, {
      name: mod.module === "(unknown)" ? "(unknown)" : truncateFile(mod.module.replace(/\/$/, "")),
      fullPath: mod.module,
      size: mod.cost,
      cost: mod.cost,
      calls: mod.calls,
      children: [],
    });
  }

  // Add hotspot functions to their parent modules
  for (const h of data.hotspots) {
    // Find the module this function belongs to
    const file = h.file ?? "";
    let parentModule: TreeNode | undefined;

    for (const [modPath, modNode] of moduleMap) {
      if (file.startsWith(modPath) || modPath === "(unknown)") {
        if (!parentModule || modPath.length > (parentModule.fullPath?.length ?? 0)) {
          parentModule = modNode;
        }
      }
    }

    if (parentModule && parentModule.children) {
      parentModule.children.push({
        name: h.function || "(anonymous)",
        fullPath: `${h.file}:${h.function}`,
        size: h.cost,
        cost: h.cost,
        calls: h.calls,
      });
    }
  }

  // Remove modules with no children (they'll show as leaf nodes)
  // and modules where children don't cover the full cost
  for (const [, modNode] of moduleMap) {
    if (modNode.children && modNode.children.length > 0) {
      const childCost = modNode.children.reduce((sum, c) => sum + c.cost, 0);
      const remainder = modNode.cost - childCost;
      if (remainder > 0.001) {
        modNode.children.push({
          name: "(other)",
          size: remainder,
          cost: remainder,
          calls: 0,
        });
      }
    }
  }

  return {
    name: "All",
    size: data.totals.cost,
    cost: data.totals.cost,
    calls: data.totals.calls,
    children: Array.from(moduleMap.values()).filter(m => m.cost > 0),
  };
}

// Custom treemap content renderer
function TreemapCell(props: any) {
  const { x, y, width, height, name, depth, index, cost, calls } = props;

  if (width < 4 || height < 4) return null;

  const color = COLORS[index % COLORS.length];
  const showLabel = width > 50 && height > 30;
  const showCost = width > 70 && height > 45;

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={color}
        fillOpacity={depth === 1 ? 0.9 : 0.7}
        stroke="var(--color-surface)"
        strokeWidth={2}
        rx={3}
        style={{ cursor: "pointer" }}
      />
      {showLabel && (
        <text
          x={x + 6}
          y={y + 16}
          fill="#fff"
          fontSize={11}
          fontFamily="JetBrains Mono"
          fontWeight={600}
        >
          {name.length > Math.floor(width / 7) ? name.slice(0, Math.floor(width / 7) - 1) + "..." : name}
        </text>
      )}
      {showCost && (
        <text
          x={x + 6}
          y={y + 30}
          fill="rgba(255,255,255,0.8)"
          fontSize={10}
          fontFamily="JetBrains Mono"
        >
          {formatCost(cost)} · {calls?.toLocaleString()} calls
        </text>
      )}
    </g>
  );
}

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const data = payload[0].payload;
  return (
    <div className="bg-surface-raised border border-border rounded-sm px-3 py-2 shadow-lg">
      <div className="text-xs font-mono font-semibold text-text-primary mb-1">{data.name}</div>
      <div className="text-[10px] font-mono text-text-secondary space-y-0.5">
        <div>Cost: {formatCost(data.cost)}</div>
        <div>Calls: {data.calls?.toLocaleString() ?? "—"}</div>
        {data.fullPath && <div className="text-text-muted truncate max-w-[200px]">{data.fullPath}</div>}
      </div>
    </div>
  );
}

export default function CostTreemap({ data }: Props) {
  const [drillPath, setDrillPath] = useState<string[]>([]);

  const tree = buildTree(data);

  // Navigate to the drilled-down node
  let currentNode = tree;
  for (const segment of drillPath) {
    const child = currentNode.children?.find(c => c.name === segment);
    if (child && child.children && child.children.length > 0) {
      currentNode = child;
    } else {
      break;
    }
  }

  const handleClick = useCallback((node: any) => {
    if (node?.children && node.children.length > 0) {
      setDrillPath(prev => [...prev, node.name]);
    }
  }, []);

  const handleBack = useCallback(() => {
    setDrillPath(prev => prev.slice(0, -1));
  }, []);

  const treemapData = currentNode.children && currentNode.children.length > 0
    ? currentNode.children
    : [currentNode];

  return (
    <div className="bg-surface-raised border border-border rounded-sm p-4">
      <div className="flex items-center gap-2 mb-4">
        {drillPath.length > 0 && (
          <button
            onClick={handleBack}
            className="flex items-center gap-1 text-xs font-mono text-accent hover:text-accent-hover transition-colors cursor-pointer"
          >
            <ChevronLeft size={14} />
            Back
          </button>
        )}
        <div className="flex items-center gap-1.5 text-xs font-mono text-text-muted">
          <span
            className={drillPath.length > 0 ? "text-accent cursor-pointer hover:text-accent-hover" : "text-text-primary font-semibold"}
            onClick={() => setDrillPath([])}
          >
            All
          </span>
          {drillPath.map((seg, i) => (
            <span key={i}>
              <span className="text-text-muted mx-1">/</span>
              <span
                className={i === drillPath.length - 1 ? "text-text-primary font-semibold" : "text-accent cursor-pointer hover:text-accent-hover"}
                onClick={() => setDrillPath(prev => prev.slice(0, i + 1))}
              >
                {seg}
              </span>
            </span>
          ))}
        </div>
        <span className="text-[10px] font-mono text-text-muted ml-auto">
          {formatCost(currentNode.cost)} total · click to drill down
        </span>
      </div>

      <ResponsiveContainer width="100%" height={320}>
        <Treemap
          data={treemapData}
          dataKey="size"
          stroke="none"
          content={<TreemapCell />}
          onClick={handleClick}
          animationDuration={200}
        >
          <Tooltip content={<CustomTooltip />} />
        </Treemap>
      </ResponsiveContainer>
    </div>
  );
}
