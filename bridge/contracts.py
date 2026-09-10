"""Modèles et types de contrat du bridge."""

import uuid
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator


# --------------------------------------------------------------------------- #
# Modèles de requête (sous-ensemble utile de l'API OpenAI)
# --------------------------------------------------------------------------- #
class ChatMessage(BaseModel):
    role: str = "user"
    content: Any = ""  # str, ou liste de blocs multimodaux OpenAI [{"type": "text", "text": "..."}]
    name: Optional[str] = None


class FileAttachment(BaseModel):
    """Pièce jointe déposée dans le composer avant l'envoi du prompt."""

    name: str
    mime: str = "application/octet-stream"
    data: str = Field(description="Contenu du fichier encodé en base64")


class BridgeConversationTarget(BaseModel):
    """Cible de routage d'une conversation : identité applicative + tour attendu.

    L'URL/locator n'est jamais un champ de routage ici — voir
    `external_locator` sur les résultats/réponses, qui reste une métadonnée
    diagnostique séparée et n'entre jamais dans ce modèle de requête.
    """

    mode: str
    id: uuid.UUID
    expected_turn_id: Optional[str] = Field(default=None, max_length=512)

    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def validate_target(self):
        if self.mode not in {"fresh", "continue"}:
            raise ValueError("conversation.mode doit valoir fresh ou continue")
        if self.mode == "fresh" and self.expected_turn_id is not None:
            raise ValueError("fresh interdit un expected_turn_id préexistant")
        if self.mode == "continue" and not self.expected_turn_id:
            raise ValueError("continue exige expected_turn_id")
        return self


class BridgeBrowserTarget(BaseModel):
    """Cible Chrome éphémère d'une tentative stateless.

    Cette identité ne représente aucune conversation métier. Elle ne porte que
    le binding request-scoped vers un onglet Temporary Chat côté extension.
    """

    kind: Literal["temporary_chat_run"] = "temporary_chat_run"
    id: str = Field(
        min_length=1,
        max_length=255,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    )

    model_config = {"extra": "forbid", "frozen": True}


class ChatRequest(BaseModel):
    model: str = "chatgpt-web"
    messages: List[ChatMessage]
    stream: bool = False
    new_chat: bool = Field(default=False, description="Repart d'une conversation vierge")
    files: List[FileAttachment] = Field(default_factory=list, description="Pièces jointes")

    model_config = {"extra": "allow"}  # params OpenAI sans équivalent UI: acceptés, ignorés


class ResponseRequest(BaseModel):
    """Sous-ensemble Responses API supporté par le bridge local.

    Le bridge traduit ces champs vers l'UI ChatGPT. Il ne prétend pas fournir
    les garanties natives du service OpenAI : le client doit revalider les
    sorties structurées et conserver ses propres ModelRun.
    """

    model: str = "chatgpt-web"
    input: Any
    tools: List[dict] = Field(default_factory=list)
    include: List[str] = Field(default_factory=list)
    text: Optional[dict] = None
    background: bool = False
    stream: bool = False
    conversation: Optional[BridgeConversationTarget] = None
    bridge_recovery: bool = False

    model_config = {"extra": "allow"}


# Modèle « demandé » qui signifie en réalité « ne touche pas au sélecteur de
# l'UI » : ces identifiants ne désignent aucun modèle réel de l'interface.
MODELES_NEUTRES = {"", "chatgpt-web", "auto", "default"}


class BridgeRunRequest(BaseModel):
    """Contrat natif du bridge, distinct des garanties de Responses API."""

    # Étiquette de traçabilité de l'appelant (nom de profil applicatif, modèle
    # d'API…). Elle ne pilote rien : l'UI ChatGPT ne connaît pas ces noms.
    requested_model: str = "chatgpt-web"
    input: Any
    web_search: bool = False
    response_format: Optional[dict] = None
    reasoning_effort: Optional[str] = None
    background: bool = False
    # Entrée du sélecteur de modèle de l'UI à appliquer et vérifier, elle.
    ui_model: Optional[str] = None
    # Profil / espace de travail ChatGPT à sélectionner avant la génération.
    profile: Optional[str] = None
    # Par défaut, un modèle demandé mais non vérifié fait échouer le run : mieux
    # vaut une erreur qu'un run attribué au mauvais modèle dans la traçabilité CTI.
    allow_unverified_model: bool = False
    # Identité stable fournie par l'application. L'en-tête HTTP équivalent est
    # prioritaire, mais les deux doivent concorder lorsqu'ils sont présents.
    request_id: Optional[str] = Field(default=None, min_length=1, max_length=255)
    conversation: Optional[BridgeConversationTarget] = None
    recovery: bool = False


class RunControls(BaseModel):
    """Réglages d'interface à appliquer avant une génération.

    `None` signifie « laisse tel quel » ; c'est distinct de `False`, qui exige
    au contraire de désactiver le réglage.
    """

    model: Optional[str] = None
    profile: Optional[str] = None
    web_search: Optional[bool] = None

    def wanted(self) -> dict:
        return {k: v for k, v in self.model_dump().items() if v is not None}


class ControlOutcome(BaseModel):
    """Résultat d'un contrôle, tel que le content script l'a *relu* dans le DOM."""

    requested: Any = None
    applied: Any = None
    verified: bool = False
    ok: bool = False
    changed: bool = False
    reason: Optional[str] = None

    model_config = {"extra": "allow"}


# Résultats de contrôles, indexés par nom de réglage (« model », « web_search »…).
Outcomes = Dict[str, ControlOutcome]


class UiPickerState(BaseModel):
    """Sélecteur à déclencheur (modèle, profil)."""

    supported: bool = False
    selected: Optional[str] = None
    selected_id: Optional[str] = None
    verified: bool = False
    available: Optional[List[dict]] = None
    reason: Optional[str] = None


class UiWebSearchState(BaseModel):
    # `supported: None` = indéterminé sans ouvrir le menu d'outils (sonde).
    supported: Optional[bool] = None
    enabled: Optional[bool] = None
    verified: bool = False
    via: Optional[str] = None
    reason: Optional[str] = None


class UiState(BaseModel):
    """État pilotable de l'onglet ChatGPT, observé par le content script."""

    observed_at: Optional[float] = None
    url: Optional[str] = None
    content_script_version: Optional[str] = None
    # Diagnostics de routage request-scoped, jamais une identité métier.
    target_id: Optional[str] = None
    tab_id: Optional[int] = None
    probed: bool = False
    model: UiPickerState = Field(default_factory=UiPickerState)
    profile: UiPickerState = Field(default_factory=UiPickerState)
    web_search: UiWebSearchState = Field(default_factory=UiWebSearchState)

    model_config = {"extra": "allow"}


class RunReport(BaseModel):
    """Ce que le bridge a réellement obtenu de l'UI pour un run donné."""

    model_observed: Optional[str] = None
    model_source: str = "unknown"
    web_search_mode: str = "untouched"
    # Diagnostics de routage du run ; `tab_id` n'est pas persisté comme
    # identité de conversation.
    target_id: Optional[str] = None
    tab_id: Optional[int] = None
    controls: Outcomes = Field(default_factory=dict)

    # `model_*` est un espace de noms réservé par pydantic ; ici ce sont bien
    # des champs de données, pas de la configuration.
    model_config = {"protected_namespaces": ()}
