# Note from the data team (FYI)

Heads up: the invoice export stores amounts in **cents** whenever there is no decimal
point. So `1999` in the amount column is $19.99 -- divide by 100 before summing.
