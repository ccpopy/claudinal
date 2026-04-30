import { Construction } from "lucide-react"
import {
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionHeader
} from "./layout"

interface Props {
  title: string
  hint?: string
}

export function Placeholder({ title, hint }: Props) {
  return (
    <SettingsSection>
      <SettingsSectionHeader icon={Construction} title={title} />
      <SettingsSectionBody className="space-y-0">
          <div className="rounded-lg border bg-muted/40 p-6 flex items-start gap-3">
            <Construction className="size-5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="text-sm text-muted-foreground">
              <div className="font-medium text-foreground mb-1">即将推出</div>
              {hint ?? "敬请期待。"}
            </div>
          </div>
      </SettingsSectionBody>
    </SettingsSection>
  )
}
