import { describe, expect, it } from "vitest"
import {
  mergeSlashCommands,
  slashCommandsFromSkills,
  type SlashCommandSkill
} from "./slashCommands"

describe("slashCommands.mergeSlashCommands", () => {
  it("normalizes leading slashes and removes duplicates", () => {
    expect(
      mergeSlashCommands(["clear", "/review"], ["review", "  /usage  "])
    ).toEqual(["clear", "review", "usage"])
  })
})

describe("slashCommands.slashCommandsFromSkills", () => {
  it("exposes only user invocable skills as slash commands", () => {
    const skills: SlashCommandSkill[] = [
      { name: "playwright-cli", user_invocable: true },
      { name: "internal-helper", user_invocable: false },
      { name: "/docs", user_invocable: true }
    ]

    expect(slashCommandsFromSkills(skills)).toEqual(["playwright-cli", "docs"])
  })
})
