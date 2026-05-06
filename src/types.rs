use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NodeKind {
    Btn,
    Inp,
    Lnk,
    Txt,
    Img,
    Sel,
    Chk,
}

impl NodeKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Btn => "BTN",
            Self::Inp => "INP",
            Self::Lnk => "LNK",
            Self::Txt => "TXT",
            Self::Img => "IMG",
            Self::Sel => "SEL",
            Self::Chk => "CHK",
        }
    }

    pub fn abbrev(self) -> char {
        match self {
            Self::Btn => 'B',
            Self::Inp => 'I',
            Self::Lnk => 'L',
            Self::Txt => 'T',
            Self::Img => 'M',
            Self::Sel => 'S',
            Self::Chk => 'K',
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionVerb {
    Click,
    Type,
    Select,
    Scroll,
    Hover,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AgentAction {
    pub action: ActionVerb,
    pub id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize)]
pub struct BBox {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenMode {
    Normal,
    Ultra,
}
