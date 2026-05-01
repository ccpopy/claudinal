// 进程级 Buddy bones 单例：splash 与 main 都从这里取同一只，
// 让两个不同 origin 的窗口看到的 Buddy 完全一致。
//
// 模板/规则与前端 src/lib/buddyBones.ts 同步；后端只负责 roll，
// 渲染（ASCII 拼帧）仍在前端做。

use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

const SPECIES: &[&str] = &["cat", "duck", "owl", "dragon", "robot", "blob"];
const EYES: &[&str] = &["dot", "round", "happy", "star", "sleepy", "sharp"];
const RARITY_WEIGHTS: &[(&str, u32)] = &[
    ("common", 60),
    ("uncommon", 25),
    ("rare", 10),
    ("epic", 4),
    ("legendary", 1),
];

const HAT_UNCOMMON: &[&str] = &["cap", "halo"];
const HAT_RARE: &[&str] = &["cap", "halo", "tophat"];
const HAT_EPIC: &[&str] = &["tophat", "wizard", "crown"];
const HAT_LEGENDARY: &[&str] = &["crown", "halo", "wizard"];

#[derive(Debug, Clone, Serialize)]
pub struct Bones {
    pub species: &'static str,
    pub eye: &'static str,
    pub rarity: &'static str,
    pub shiny: bool,
    pub hat: &'static str,
}

struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    fn next_u32(&mut self) -> u32 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let a = self.state;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        t ^ (t >> 14)
    }

    fn next_f64(&mut self) -> f64 {
        f64::from(self.next_u32()) / 4_294_967_296.0
    }
}

fn fresh_seed() -> u32 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mixed = (nanos as u64) ^ ((nanos >> 64) as u64) ^ (std::process::id() as u64);
    (mixed as u32) ^ ((mixed >> 32) as u32)
}

fn pick<'a>(items: &[&'a str], rng: &mut Mulberry32) -> &'a str {
    let idx = (rng.next_f64() * items.len() as f64).floor() as usize;
    items[idx.min(items.len() - 1)]
}

fn pick_weighted(items: &[(&'static str, u32)], rng: &mut Mulberry32) -> &'static str {
    let total: u32 = items.iter().map(|(_, w)| *w).sum();
    let mut roll = rng.next_f64() * f64::from(total);
    for (key, weight) in items {
        roll -= f64::from(*weight);
        if roll < 0.0 {
            return *key;
        }
    }
    items[0].0
}

fn roll() -> Bones {
    let mut rng = Mulberry32::new(fresh_seed());
    let species = pick(SPECIES, &mut rng);
    let eye = pick(EYES, &mut rng);
    let rarity = pick_weighted(RARITY_WEIGHTS, &mut rng);
    let shiny = rng.next_f64() < 0.01;
    let hat = if rarity == "common" {
        "none"
    } else {
        let pool: &[&str] = match rarity {
            "uncommon" => HAT_UNCOMMON,
            "rare" => HAT_RARE,
            "epic" => HAT_EPIC,
            "legendary" => HAT_LEGENDARY,
            _ => &[],
        };
        pick(pool, &mut rng)
    };
    Bones {
        species,
        eye,
        rarity,
        shiny,
        hat,
    }
}

static BONES: OnceLock<Bones> = OnceLock::new();

pub fn current() -> &'static Bones {
    BONES.get_or_init(roll)
}

pub fn current_json() -> String {
    serde_json::to_string(current()).unwrap_or_else(|_| "null".to_string())
}

#[tauri::command]
pub fn get_buddy_bones() -> Bones {
    current().clone()
}
