START TRANSACTION;

-- Caso 1: Yeraldine
UPDATE recursos SET activo=0, motivo_inactivacion='Duplicado - se conserva el ID 96142c3c (yeraldinehernandez04)' WHERE id='dccf6621-f6cf-4fff-af1a-031f696c915d';
UPDATE usuarios SET activo=0 WHERE recurso_id='dccf6621-f6cf-4fff-af1a-031f696c915d';

-- Caso 2: Juliana
UPDATE recursos SET activo=0, motivo_inactivacion='Duplicado - se conserva el ID 1082d770 (julianagrisales2001)' WHERE id='c42800f5-8f95-4642-b54e-ed1cb099a09b';
UPDATE usuarios SET activo=0 WHERE recurso_id='c42800f5-8f95-4642-b54e-ed1cb099a09b';

-- Caso 3: Keyla - mover 1 asignacion + desactivar
UPDATE asignaciones SET recurso_id='a782fb30-6021-455a-bb27-b1afd5ca94b5' WHERE recurso_id='8dc901e0-a1e6-4e90-a8fe-974d0fdcca27';
UPDATE asignaciones SET auxiliar_id='a782fb30-6021-455a-bb27-b1afd5ca94b5' WHERE auxiliar_id='8dc901e0-a1e6-4e90-a8fe-974d0fdcca27';
UPDATE asignaciones SET auxiliar2_id='a782fb30-6021-455a-bb27-b1afd5ca94b5' WHERE auxiliar2_id='8dc901e0-a1e6-4e90-a8fe-974d0fdcca27';
UPDATE recursos SET activo=0, motivo_inactivacion='Duplicado - asignaciones movidas al ID a782fb30 (gomezkeyla851)' WHERE id='8dc901e0-a1e6-4e90-a8fe-974d0fdcca27';
UPDATE usuarios SET activo=0 WHERE recurso_id='8dc901e0-a1e6-4e90-a8fe-974d0fdcca27';

-- Caso 4: Shaila
UPDATE recursos SET activo=0, motivo_inactivacion='Duplicado - se conserva el ID 57c89d6f (shailapahuana)' WHERE id='b5c5cffd-a6fd-42bd-b888-d30e25544d50';
UPDATE usuarios SET activo=0 WHERE recurso_id='b5c5cffd-a6fd-42bd-b888-d30e25544d50';

-- Caso 5: Grace
UPDATE recursos SET activo=0, motivo_inactivacion='Duplicado - se conserva el ID d5ff493c (con asignaciones)' WHERE id='ce215ff0-5034-4760-9510-03afe458264f';
UPDATE usuarios SET activo=0 WHERE recurso_id='ce215ff0-5034-4760-9510-03afe458264f';

-- Caso 6: Deiris vs Deirys
UPDATE recursos SET activo=0, motivo_inactivacion='Duplicado - se conserva el ID 5ccc86ed (neomarbenitez1985)' WHERE id='7f96a6c0-8245-4c6f-8f4d-e20b1ef41414';
UPDATE usuarios SET activo=0 WHERE recurso_id='7f96a6c0-8245-4c6f-8f4d-e20b1ef41414';

COMMIT;
