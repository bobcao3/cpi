export interface VcsRepository {
  getStatus(): string | null;
  onChange(callback: () => void): () => void;
  refresh?(): Promise<void>;
  dispose(): void;
}

export interface VcsProvider {
  readonly id: string;
  detect(directory: string): boolean;
  open(root: string): VcsRepository;
}
