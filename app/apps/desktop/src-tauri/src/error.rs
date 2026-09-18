//! A single error type shared by all commands. It serializes to a plain string
//! so the React layer receives a readable message from `invoke(...)` rejections.

use serde::{Serialize, Serializer};

#[derive(Debug)]
pub struct AppError(pub String);

impl AppError {
    pub fn new(msg: impl Into<String>) -> Self {
        AppError(msg.into())
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for AppError {}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

macro_rules! from_err {
    ($t:ty) => {
        impl From<$t> for AppError {
            fn from(e: $t) -> Self {
                AppError(e.to_string())
            }
        }
    };
}

from_err!(std::io::Error);
from_err!(rusqlite::Error);
from_err!(serde_json::Error);
from_err!(notify::Error);
from_err!(tauri::Error);

pub type AppResult<T> = Result<T, AppError>;
