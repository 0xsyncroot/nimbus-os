// types.ts — SPEC-847: shared modal prop types.

/**
 * Base props every modal must accept. onClose is called when the modal
 * should be dismissed (Esc, q, or explicit confirm/cancel).
 */
export interface ModalProps {
  onClose: () => void;
}
