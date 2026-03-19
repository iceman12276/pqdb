import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";

/**
 * Encryption section for project settings page.
 * Explains the zero-knowledge model, key type, and backup best practices.
 */
export function EncryptionSettings() {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Encryption</h2>

      {/* Zero-Knowledge Model */}
      <Card>
        <CardHeader>
          <CardTitle>Zero-Knowledge Architecture</CardTitle>
          <CardDescription>
            Your encryption key is never sent to the server. All sensitive data
            is encrypted client-side before transmission.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h4 className="text-sm font-medium mb-2">Key Type</h4>
            <p className="text-sm text-muted-foreground">
              <Badge variant="outline" className="mr-2">ML-KEM-768</Badge>
              NIST-standardized post-quantum key encapsulation mechanism
            </p>
          </div>

          <div>
            <h4 className="text-sm font-medium mb-2">What It Protects</h4>
            <p className="text-sm text-muted-foreground">
              Columns marked as <Badge variant="outline" className="mx-1">searchable</Badge>
              or <Badge variant="outline" className="mx-1">private</Badge> are
              encrypted with your key before being stored. Plain columns are
              stored unencrypted.
            </p>
          </div>

          <div>
            <h4 className="text-sm font-medium mb-2">What Happens If You Lose Your Key</h4>
            <p className="text-sm text-destructive">
              If you lose your encryption key, your encrypted data is
              permanently unrecoverable. The server cannot decrypt your data
              because it never holds your key.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Backup Recommendations */}
      <Card>
        <CardHeader>
          <CardTitle>Key Backup Recommendations</CardTitle>
          <CardDescription>
            Follow these best practices to ensure you never lose access to your
            encrypted data.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3 text-sm">
            <li className="flex gap-3">
              <span className="font-medium text-muted-foreground shrink-0">1.</span>
              <div>
                <p className="font-medium">Password manager</p>
                <p className="text-muted-foreground">
                  Store your encryption key in a reputable password manager
                  (e.g., 1Password, Bitwarden). This is the most convenient
                  option for daily use.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="font-medium text-muted-foreground shrink-0">2.</span>
              <div>
                <p className="font-medium">Secure vault</p>
                <p className="text-muted-foreground">
                  Keep a copy in your organization&apos;s secret management system
                  (e.g., HashiCorp Vault, AWS Secrets Manager) for team access
                  and disaster recovery.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="font-medium text-muted-foreground shrink-0">3.</span>
              <div>
                <p className="font-medium">Offline backup</p>
                <p className="text-muted-foreground">
                  Write the key on paper or store it on an encrypted USB drive.
                  Keep it in a physically secure location separate from your
                  primary backup.
                </p>
              </div>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
