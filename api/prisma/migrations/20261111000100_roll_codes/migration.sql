-- Roll codes come from sequences, as bundle codes do, so two receipts at once
-- can never draw the same code. Test rolls count apart: T-0001 on.
CREATE SEQUENCE roll_code_seq START WITH 1001;
GRANT USAGE, SELECT ON SEQUENCE roll_code_seq TO ff_app;

CREATE SEQUENCE test_roll_code_seq START WITH 1;
GRANT USAGE, SELECT ON SEQUENCE test_roll_code_seq TO ff_app;
