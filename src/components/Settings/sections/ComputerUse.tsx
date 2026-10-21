import { Monitor } from "lucide-react"
import { ComputerUseDriverSetup, ComputerUseEnableSwitch } from "@/components/ComputerUse"
import { useComputerUseSnapshot } from "@/hooks/useComputerUse"
import { SettingsCard, SettingsCardTitle, SettingsSection, SettingsSectionBody, SettingsSectionHeader } from "./layout"

export function ComputerUseSettings() {
  const snapshot = useComputerUseSnapshot()
  return <SettingsSection>
    <SettingsSectionHeader title="电脑使用" icon={Monitor} description="让 Claude 在你授权的 Windows 应用中查看和操作。" />
    <SettingsSectionBody>
      <SettingsCard><ComputerUseEnableSwitch snapshot={snapshot} /></SettingsCard>
      <SettingsCard><SettingsCardTitle>CuaDriver</SettingsCardTitle><ComputerUseDriverSetup /></SettingsCard>
    </SettingsSectionBody>
  </SettingsSection>
}
