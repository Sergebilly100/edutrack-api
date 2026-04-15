# Documents Module

Module API pour gérer les documents administratifs professeurs/élèves avec stockage Cloudflare R2 (ou fallback local en dev/test si `R2_ACCOUNT_ID` est vide).

## Variables d'environnement

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_ENDPOINT` (optionnel)
- `DOCUMENTS_LOCAL_STORAGE_ROOT` (optionnel, défaut: `/tmp/edutrack-docs`)

Si `R2_ACCOUNT_ID` est vide, le module stocke localement dans `/tmp/edutrack-docs`.

## Types de documents et extensions autorisés

- Types: `diplome`, `cni`, `contrat`, `releve_notes`, `photo`, `autre`
- Extensions: `.pdf`, `.jpg`, `.jpeg`, `.png`
- Taille max: 10 Mo

## Tests manuels `curl`

Pré-requis:

```bash
export API="http://localhost:3000"
export TOKEN="<jwt_director>"
export TEACHER_ID="<uuid_teacher>"
```

1. Upload document professeur

```bash
curl -X POST "$API/api/v1/documents/teacher/$TEACHER_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -F "type=diplome" \
  -F "name=Diplome BAC" \
  -F "file=@/tmp/diplome.pdf"
```

2. Lister les documents d'une entité

```bash
curl "$API/api/v1/documents/teacher/$TEACHER_ID" \
  -H "Authorization: Bearer $TOKEN"
```

3. Obtenir URL de téléchargement signée (1h)

```bash
export DOCUMENT_ID="<uuid_document>"
curl "$API/api/v1/documents/$DOCUMENT_ID/download" \
  -H "Authorization: Bearer $TOKEN"
```

4. Suppression (stockage + DB)

```bash
curl -X DELETE "$API/api/v1/documents/$DOCUMENT_ID" \
  -H "Authorization: Bearer $TOKEN"
```

5. Vérifier suppression

```bash
curl "$API/api/v1/documents/teacher/$TEACHER_ID" \
  -H "Authorization: Bearer $TOKEN"
```
