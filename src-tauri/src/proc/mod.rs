pub mod capabilities;
mod control;
pub mod diagnostics;
pub mod manager;
mod metadata_probe;
pub mod runtime_controls;
pub mod spawn;
mod supervisor;
mod transport;

pub use manager::{Manager, SpawnOptions};
pub(crate) use supervisor::ProcessTree;
