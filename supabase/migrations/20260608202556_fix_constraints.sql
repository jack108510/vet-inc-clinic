-- Drop the CHECK constraint on std_services.category
ALTER TABLE std_services DROP CONSTRAINT IF EXISTS std_services_category_check;
ALTER TABLE std_services ADD CONSTRAINT std_services_category_check CHECK (category IN ('exam','surgery','lab','vaccine','dental','imaging','pharmacy','boarding','grooming','emergency','wellness','nutrition','behaviour','other','AM','AI','AS','AX','OV','SX','TX','LAB','VX','RX','MX','PX'));

-- Make std_patients.client_id nullable
ALTER TABLE std_patients ALTER COLUMN client_id DROP NOT NULL;
