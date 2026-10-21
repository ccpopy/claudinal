import { Monitor } from "lucide-react"
import { ComputerUseDriverSetup } from "@/components/ComputerUse"
import { SettingsCard, SettingsCardTitle, SettingsHint, SettingsSection, SettingsSectionBody, SettingsSectionHeader } from "./layout"

export function ComputerUseSettings() {
  return <SettingsSection>
    <SettingsSectionHeader title="电脑使用" icon={Monitor} description="为 Windows 应用设置本地电脑使用支持。" />
    <SettingsSectionBody>
      <SettingsCard><SettingsCardTitle>CuaDriver</SettingsCardTitle><ComputerUseDriverSetup /></SettingsCard>
      <SettingsHint>电脑使用默认关闭。请回到对话开启，再逐个授权应用；授权不会保存为全局设置，也不会转移到其他对话。</SettingsHint>
    </SettingsSectionBody>
  </SettingsSection>
}
