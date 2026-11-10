-- Affichage uniforme des noms : « NOM Prénoms » (nom en majuscules, prénoms capitalisés, particules en minuscules).
-- Même algorithme que edutrack-api/src/shared/utils/person-name.ts (et sa copie web) : table de cas partagée.
-- Indépendante de la locale de la base (accents traités par translate) ; ne modifie aucune donnée stockée.
-- Idempotent : CREATE OR REPLACE FUNCTION.
CREATE OR REPLACE FUNCTION "tenant"."format_person_name"(p_first text, p_last text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_lower constant text := 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿœæ';
  v_upper constant text := 'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝŸŒÆ';
  v_particles constant text[] := ARRAY['de', 'du', 'des', 'van', 'von', 'der', 'den', 'di', 'da', 'dos', 'del', 'la', 'le'];
  v_last text;
  v_first text;
  v_words text[];
  v_word text;
  v_prefix text;
  v_res text;
  v_cap boolean;
  v_c text;
  v_out text[] := ARRAY[]::text[];
  v_i int;
  v_j int;
BEGIN
  v_last := upper(translate(btrim(regexp_replace(coalesce(p_last, ''), '\s+', ' ', 'g')), v_lower, v_upper));
  v_first := lower(translate(btrim(regexp_replace(coalesce(p_first, ''), '\s+', ' ', 'g')), v_upper, v_lower));
  v_words := string_to_array(v_first, ' ');
  FOR v_i IN 1 .. coalesce(array_length(v_words, 1), 0) LOOP
    v_word := v_words[v_i];
    IF v_word = '' THEN CONTINUE; END IF;
    IF v_i > 1 AND v_word = ANY (v_particles) THEN
      v_out := v_out || v_word;
      CONTINUE;
    END IF;
    v_prefix := '';
    IF v_i > 1 AND v_word ~ '^[dl][''’].+' THEN
      v_prefix := left(v_word, 2);
      v_word := substr(v_word, 3);
    END IF;
    v_res := '';
    v_cap := true;
    FOR v_j IN 1 .. char_length(v_word) LOOP
      v_c := substr(v_word, v_j, 1);
      v_res := v_res || CASE WHEN v_cap THEN upper(translate(v_c, v_lower, v_upper)) ELSE v_c END;
      v_cap := v_c IN ('-', '''', '’');
    END LOOP;
    v_out := v_out || (v_prefix || v_res);
  END LOOP;
  RETURN concat_ws(' ', NULLIF(v_last, ''), NULLIF(array_to_string(v_out, ' '), ''));
END;
$fn$;
