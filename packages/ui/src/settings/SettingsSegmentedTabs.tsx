import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";

interface SettingsSegmentedTabItem<TValue extends string> {
  label: string;
  value: TValue;
}

export const SETTINGS_SEGMENTED_TABS_LIST_CLASS =
  "flex h-8 items-center rounded-full bg-surface p-0.5 group-data-horizontal/tabs:h-8";

export const SETTINGS_SEGMENTED_TABS_TRIGGER_CLASS =
  "h-7 flex-none rounded-full border-transparent bg-transparent px-3 text-ui-base font-medium text-foreground-subtle transition-all hover:text-foreground data-[state=active]:border-transparent data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-xs data-[state=active]:font-semibold data-active:border-transparent data-active:bg-card data-active:text-foreground data-active:shadow-xs data-active:font-semibold";

/** 设置详情页与弹窗共用的胶囊药丸分段切换（rounded-full）。 */
export function SettingsSegmentedTabs<TValue extends string>({
  items,
  value,
  onValueChange,
}: {
  items: readonly SettingsSegmentedTabItem<TValue>[];
  value: TValue;
  onValueChange: (value: TValue) => void;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as TValue)}
      className="gap-0"
    >
      <TabsList className={SETTINGS_SEGMENTED_TABS_LIST_CLASS}>
        {items.map((item) => (
          <TabsTrigger
            key={item.value}
            value={item.value}
            className={SETTINGS_SEGMENTED_TABS_TRIGGER_CLASS}
          >
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
