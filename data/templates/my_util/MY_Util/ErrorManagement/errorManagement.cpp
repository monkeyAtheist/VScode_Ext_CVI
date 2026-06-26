#include "errorManagement.h"

jc_error::error jc_error::erreur;

void jc_error::error::printErrorLog()
{
	std::fstream f(this->path, std::ios::out | std::ios::trunc);
	f << "test";
}